import fs from 'node:fs/promises';
import path from 'node:path';

const MASTER_URL = process.env.GR_RBX_MASTER_URL;
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const MAP_FILE = path.join(DATA_DIR, 'universe-map.json');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const MAX_IDS_PER_BATCH = 100;

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

const universeMap = await readJsonSafe(MAP_FILE, {});
const unresolvedPlaceIds = placeIds.filter(placeId => !universeMap[placeId]);

for (const placeId of unresolvedPlaceIds) {
  try {
    const universeId = await fetchUniverseId(placeId);
    universeMap[placeId] = universeId;
    await sleep(150);
  } catch (error) {
    console.warn(`Could not resolve universe for placeId ${placeId}: ${error.message}`);
  }
}

await writeJson(MAP_FILE, sortObjectByKey(universeMap));

const placeUniversePairs = placeIds
  .map(placeId => ({
    placeId,
    universeId: universeMap[placeId] ? String(universeMap[placeId]) : ''
  }))
  .filter(item => item.placeId && item.universeId);

const universeIds = [...new Set(placeUniversePairs.map(item => item.universeId))];

const gameDetails = {};
const votes = {};
const icons = {};

for (const batch of chunk(universeIds, MAX_IDS_PER_BATCH)) {
  Object.assign(gameDetails, await fetchGameDetails(batch));
  await sleep(250);
  Object.assign(votes, await fetchVotes(batch));
  await sleep(250);
  Object.assign(icons, await fetchIcons(batch));
  await sleep(250);
}

const generatedAtUtc = formatUtc(new Date());
const indexItems = [];

for (const item of placeUniversePairs) {
  const game = gameDetails[item.universeId];

  if (!game) {
    console.warn(`Missing game details for placeId ${item.placeId}, universeId ${item.universeId}`);
    continue;
  }

  const vote = votes[item.universeId] || {};
  const iconUrl = icons[item.universeId] || '';
  const rootPlaceId = stringValue(game.rootPlaceId || item.placeId);

  const payload = {
    ok: true,
    status: 'static',
    placeId: stringValue(item.placeId),
    rootPlaceId,
    universeId: stringValue(item.universeId),
    name: stringValue(game.name || 'Roblox Experience'),
    creatorName: game.creator && game.creator.name ? stringValue(game.creator.name) : 'Unknown Developer',
    creatorType: game.creator && game.creator.type ? stringValue(game.creator.type) : '',
    playing: numberValue(game.playing),
    visits: numberValue(game.visits),
    favorites: numberValue(game.favoritedCount || game.favorites),
    likes: numberValue(vote.upVotes),
    dislikes: numberValue(vote.downVotes),
    thumbnailUrl: iconUrl,
    robloxUrl: `https://www.roblox.com/games/${rootPlaceId}`,
    fetchedAtUtc: generatedAtUtc
  };

  await writeJson(path.join(DATA_DIR, `place-${item.placeId}.json`), payload);
  await writeJs(path.join(DATA_DIR, `place-${item.placeId}.js`), item.placeId, payload);

  indexItems.push({
    placeId: payload.placeId,
    universeId: payload.universeId,
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

async function fetchUniverseId(placeId) {
  const url = `https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`;
  const json = await fetchJson(url);

  if (!json || !json.universeId) {
    throw new Error(`Missing universeId for placeId ${placeId}`);
  }

  return stringValue(json.universeId);
}

async function fetchGameDetails(universeIds) {
  const url = `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeIds.join(','))}`;
  const json = await fetchJson(url);
  const output = {};

  for (const item of json.data || []) {
    if (item && item.id) {
      output[stringValue(item.id)] = item;
    }
  }

  return output;
}

async function fetchVotes(universeIds) {
  const url = `https://games.roblox.com/v1/games/votes?universeIds=${encodeURIComponent(universeIds.join(','))}`;
  const json = await fetchJson(url);
  const output = {};

  for (const item of json.data || []) {
    if (item && item.id) {
      output[stringValue(item.id)] = {
        upVotes: numberValue(item.upVotes),
        downVotes: numberValue(item.downVotes)
      };
    }
  }

  return output;
}

async function fetchIcons(universeIds) {
  const url = `https://thumbnails.roblox.com/v1/games/icons?universeIds=${encodeURIComponent(universeIds.join(','))}&size=512x512&format=Png&isCircular=false`;
  const json = await fetchJson(url);
  const output = {};

  for (const item of json.data || []) {
    if (item && item.targetId) {
      output[stringValue(item.targetId)] = stringValue(item.imageUrl || '');
    }
  }

  return output;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GameRant-Roblox-Stats/1.0'
    }
  });

  const text = await response.text();

  if (!response.ok) {
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

async function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
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

function sortObjectByKey(value) {
  return Object.keys(value)
    .sort((a, b) => Number(a) - Number(b))
    .reduce((output, key) => {
      output[key] = value[key];
      return output;
    }, {});
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
