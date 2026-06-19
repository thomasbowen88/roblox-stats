import fs from 'node:fs/promises';
import path from 'node:path';

const MASTER_URL = process.env.GR_RBX_MASTER_URL;
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const MAX_PLACE_IDS_PER_BATCH = 50;
const BATCH_DELAY_MS = 1000;
const FETCH_RETRIES = 4;

if (!MASTER_URL) {
  throw new Error('Missing GR_RBX_MASTER_URL.');
}

await fs.mkdir(DATA_DIR, { recursive: true });

const master = await fetchJson(MASTER_URL);
const placeIds = normalizePlaceIds(master.placeIds || []);

if (!placeIds.length) {
  await writeJson(INDEX_FILE, {
    generatedAtUtc: formatUtc(new Date()),
    count: 0,
    items: []
  });
  process.exit(0);
}

const generatedAtUtc = formatUtc(new Date());
const detailsByPlaceId = {};

for (const batch of chunk(placeIds, MAX_PLACE_IDS_PER_BATCH)) {
  try {
    const details = await fetchPlaceDetails(batch);

    for (const item of details) {
      const placeId = stringValue(item.placeId || item.PlaceId || item.id || item.Id);

      if (placeId) {
        detailsByPlaceId[placeId] = item;
      }
    }

    await sleep(BATCH_DELAY_MS);
  } catch (error) {
    console.warn(`Batch failed for placeIds ${batch.join(',')}: ${error.message}`);
  }
}

const indexItems = [];

for (const placeId of placeIds) {
  const item = detailsByPlaceId[placeId];

  if (!item) {
    console.warn(`Missing place details for placeId ${placeId}`);
    continue;
  }

  const payload = normalizePlaceDetails(item, placeId, generatedAtUtc);

  await writeJson(path.join(DATA_DIR, `place-${placeId}.json`), payload);
  await writeJs(path.join(DATA_DIR, `place-${placeId}.js`), placeId, payload);

  indexItems.push({
    placeId: payload.placeId,
    name: payload.name,
    playing: payload.playing,
    visits: payload.visits,
    thumbnailUrl: payload.thumbnailUrl,
    fetchedAtUtc: payload.fetchedAtUtc
  });
}

indexItems.sort((a, b) => numberValue(b.playing) - numberValue(a.playing));

await writeJson(INDEX_FILE, {
  generatedAtUtc,
  count: indexItems.length,
  items: indexItems
});

console.log(`Updated ${indexItems.length} Roblox stat files.`);

async function fetchPlaceDetails(placeIds) {
  const query = placeIds
    .map(placeId => `placeIds=${encodeURIComponent(placeId)}`)
    .join('&');

  const url = `https://games.roblox.com/v1/games/multiget-place-details?${query}`;
  const json = await fetchJson(url);

  if (!Array.isArray(json)) {
    throw new Error(`Expected array from place details endpoint.`);
  }

  return json;
}

function normalizePlaceDetails(item, fallbackPlaceId, fetchedAtUtc) {
  const placeId = stringValue(item.placeId || item.PlaceId || item.id || item.Id || fallbackPlaceId);
  const name = stringValue(item.name || item.Name || item.gameName || item.GameName || 'Roblox Experience');
  const creatorName = stringValue(
    item.builder ||
    item.Builder ||
    item.creatorName ||
    item.CreatorName ||
    item.creator ||
    item.Creator ||
    'Unknown Developer'
  );

  return {
    ok: true,
    status: 'static',
    placeId,
    rootPlaceId: stringValue(item.rootPlaceId || item.RootPlaceId || placeId),
    universeId: stringValue(item.universeId || item.UniverseId || ''),
    name,
    creatorName,
    creatorType: stringValue(item.creatorType || item.CreatorType || ''),
    playing: numberValue(item.playing || item.Playing || item.playerCount || item.PlayerCount),
    visits: numberValue(item.visits || item.Visits || item.visitCount || item.VisitCount),
    favorites: numberValue(item.favorites || item.Favorites || item.favoritedCount || item.FavoritedCount),
    likes: numberValue(item.likes || item.Likes || item.upVotes || item.UpVotes),
    dislikes: numberValue(item.dislikes || item.Dislikes || item.downVotes || item.DownVotes),
    thumbnailUrl: stringValue(
      item.imageToken ||
      item.ImageToken ||
      item.thumbnailUrl ||
      item.ThumbnailUrl ||
      item.imageUrl ||
      item.ImageUrl ||
      ''
    ),
    robloxUrl: `https://www.roblox.com/games/${placeId}`,
    fetchedAtUtc
  };
}

async function fetchJson(url, attempt = 1) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GameRant-Roblox-Stats/1.0'
    }
  });

  const text = await response.text();

  if (!response.ok) {
    const shouldRetry =
      response.status === 429 ||
      response.status === 500 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504;

    if (shouldRetry && attempt < FETCH_RETRIES) {
      const waitMs = Math.min(30000, 1500 * Math.pow(2, attempt - 1));
      console.warn(`Retrying HTTP ${response.status} in ${waitMs}ms: ${url}`);
      await sleep(waitMs);
      return fetchJson(url, attempt + 1);
    }

    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON: ${text.slice(0, 300)}`);
  }
}

async function writeJs(filePath, placeId, payload) {
  const js = [
    'window.grRobloxGameInfoStatic = window.grRobloxGameInfoStatic || {};',
    `window.grRobloxGameInfoStatic[${JSON.stringify(stringValue(placeId))}] = ${JSON.stringify(payload)};`,
    ''
  ].join('\n');

  await fs.writeFile(filePath, js, 'utf8');
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizePlaceIds(values) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const placeId = stringValue(value).trim();

    if (/^\d{3,20}$/.test(placeId) && !seen.has(placeId)) {
      seen.add(placeId);
      output.push(placeId);
    }
  }

  return output;
}

function chunk(values, size) {
  const output = [];

  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }

  return output;
}

function numberValue(value) {
  const number = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : 0;
}

function stringValue(value) {
  return String(value === undefined || value === null ? '' : value);
}

function formatUtc(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
