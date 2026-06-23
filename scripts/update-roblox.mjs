import fs from 'node:fs/promises';
import path from 'node:path';

const MASTER_URL = process.env.GR_RBX_MASTER_URL;
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const MAP_FILE = path.join(DATA_DIR, 'universe-map.json');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const PLAYER_HISTORY_FILE = path.join(DATA_DIR, 'place-player-history.json');

const MAX_IDS_PER_BATCH = 50;
const RESOLVE_DELAY_MS = 750;
const BATCH_DELAY_MS = 1000;
const FETCH_RETRIES = 4;
const PLAYER_HISTORY_DAYS = 7;
const PLAYER_HISTORY_WINDOW_SECONDS = PLAYER_HISTORY_DAYS * 24 * 60 * 60;

if (!MASTER_URL) {
  throw new Error('Missing GR_RBX_MASTER_URL.');
}

await fs.mkdir(DATA_DIR, { recursive: true });

const master = await fetchJson(MASTER_URL);
const generatedAtUtc = formatUtc(new Date());

await writeCombinedStaticFiles(master, generatedAtUtc);

const placeIds = normalizePlaceIds(
  master.placeIds ||
    master.master?.placeIds ||
    []
);

if (!placeIds.length) {
  await writeJson(INDEX_FILE, {
    generatedAtUtc,
    count: 0,
    items: []
  });

  await writeJson(PLAYER_HISTORY_FILE, {});

  console.log('No Roblox place IDs found.');
  process.exit(0);
}

const universeMap = await readJsonSafe(MAP_FILE, {});
const unresolvedPlaceIds = placeIds.filter(placeId => !universeMap[placeId]);

for (const placeId of unresolvedPlaceIds) {
  try {
    const universeId = await fetchUniverseId(placeId);
    universeMap[placeId] = universeId;
    await sleep(RESOLVE_DELAY_MS);
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
  try {
    Object.assign(gameDetails, await fetchGameDetails(batch));
    await sleep(BATCH_DELAY_MS);

    Object.assign(votes, await fetchVotes(batch));
    await sleep(BATCH_DELAY_MS);

    Object.assign(icons, await fetchIcons(batch));
    await sleep(BATCH_DELAY_MS);
  } catch (error) {
    console.warn(`Batch failed for universeIds ${batch.join(',')}: ${error.message}`);
  }
}

const playerHistoryStore = normalizePlayerHistoryStore(
  await readJsonSafe(PLAYER_HISTORY_FILE, {}),
  generatedAtUtc
);

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

  payload.chartData = buildPlayerChartData(playerHistoryStore, payload, generatedAtUtc);

  await writeJson(path.join(DATA_DIR, `place-${item.placeId}.json`), payload);
  await writePlaceJs(path.join(DATA_DIR, `place-${item.placeId}.js`), item.placeId, payload);

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

await writeJson(PLAYER_HISTORY_FILE, sortPlayerHistoryStore(playerHistoryStore));

await writeJson(INDEX_FILE, {
  generatedAtUtc,
  count: indexItems.length,
  items: indexItems
});

console.log(`Updated ${indexItems.length} Roblox stat files.`);

async function writeCombinedStaticFiles(source, generatedAtUtc) {
  const placeIds = normalizePlaceIds(
    source.placeIds ||
      source.master?.placeIds ||
      []
  );

  const master = {
    count: placeIds.length,
    placeIds
  };

  const leaderboard = normalizeLeaderboardPayload(source.leaderboard || source.games || {});
  const ccu = normalizeCcuPayload(source.ccu || {});
  const hotNewGames = normalizeHotNewGamesPayload(source.hotNewGames || {});

  const widgetPayload = {
    ok: source.ok !== false,
    status: 'static_widget',
    sourceStatus: stringValue(source.status || ''),
    sourceGeneratedAtUtc: stringValue(source.generatedAtUtc || ''),
    generatedAtUtc,
    staticGeneratedAtUtc: generatedAtUtc,
    cachedForSeconds: numberValue(source.cachedForSeconds),
    count: placeIds.length,
    placeIds,
    master,
    ccu,
    games: leaderboard,
    leaderboard,
    hotNewGames
  };

  await writeJson(path.join(DATA_DIR, 'widget.json'), widgetPayload);
  await writeGlobalJs(path.join(DATA_DIR, 'widget.js'), 'grRobloxWidgetStatic', widgetPayload);

  console.log('Updated Roblox widget static file.');
}

function normalizeLeaderboardPayload(value) {
  const items = Array.isArray(value.items)
    ? value.items.map(item => ({
        snapshotUtc: stringValue(item.snapshotUtc || item.snapshot_utc || value.snapshotUtc || ''),
        rank: numberValue(item.rank),
        placeId: stringValue(item.placeId || item.place_id || ''),
        universeId: stringValue(item.universeId || item.universe_id || ''),
        name: stringValue(item.name || ''),
        playing: numberValue(item.playing),
        imageUrl: stringValue(item.imageUrl || item.image_url || '')
      })).filter(item => item.placeId && item.name)
    : [];

  items.sort((a, b) => {
    if (a.rank && b.rank && a.rank !== b.rank) {
      return a.rank - b.rank;
    }

    return b.playing - a.playing;
  });

  return {
    snapshotUtc: stringValue(value.snapshotUtc || value.snapshot_utc || (items[0] ? items[0].snapshotUtc : '')),
    count: numberValue(value.count || items.length),
    items
  };
}

function normalizeCcuPayload(value) {
  const series = Array.isArray(value.series)
    ? value.series.map(item => ({
        timestampUtc: stringValue(item.timestampUtc || item.timestamp_utc || ''),
        ccu: numberValue(item.ccu || item.roblox_ccu),
        fetchedAtUtc: stringValue(item.fetchedAtUtc || item.fetched_at_utc || ''),
        sourceLastUpdated: stringValue(item.sourceLastUpdated || item.source_last_updated || ''),
        sourceCacheTime: stringValue(item.sourceCacheTime || item.source_cache_time || '')
      })).filter(item => item.timestampUtc && Number.isFinite(item.ccu))
    : [];

  series.sort((a, b) => dateValue(a.timestampUtc) - dateValue(b.timestampUtc));

  const latest = value.latest
    ? {
        timestampUtc: stringValue(value.latest.timestampUtc || value.latest.timestamp_utc || ''),
        ccu: numberValue(value.latest.ccu || value.latest.roblox_ccu),
        fetchedAtUtc: stringValue(value.latest.fetchedAtUtc || value.latest.fetched_at_utc || ''),
        sourceLastUpdated: stringValue(value.latest.sourceLastUpdated || value.latest.source_last_updated || ''),
        sourceCacheTime: stringValue(value.latest.sourceCacheTime || value.latest.source_cache_time || '')
      }
    : series.length
      ? series[series.length - 1]
      : null;

  return {
    latest,
    count: numberValue(value.count || series.length),
    series
  };
}

function normalizeHotNewGamesPayload(value) {
  const items = Array.isArray(value.items)
    ? value.items.map(item => ({
        placeId: stringValue(item.placeId || item.place_id || ''),
        name: stringValue(item.name || ''),
        imageUrl: stringValue(item.imageUrl || item.image_url || ''),
        firstSeenUtc: stringValue(item.firstSeenUtc || item.first_seen_utc || '')
      })).filter(item => item.placeId && item.name)
    : [];

  return {
    count: numberValue(value.count || items.length),
    items
  };
}

function buildPlayerChartData(historyStore, payload, generatedAtUtc) {
  const placeId = stringValue(payload.placeId);
  const timestamp = unixTimestamp(generatedAtUtc);
  const players = numberValue(payload.playing);
  const cutoffTs = timestamp - PLAYER_HISTORY_WINDOW_SECONDS;
  const existing = Array.isArray(historyStore[placeId]) ? historyStore[placeId] : [];

  const series = existing
    .map(normalizePlayerSample)
    .filter(sample => sample && sample[0] >= cutoffTs && sample[0] !== timestamp);

  series.push([timestamp, players]);
  series.sort((a, b) => a[0] - b[0]);

  historyStore[placeId] = series;

  const peak7d = series.reduce((peak, sample) => {
    if (!peak || sample[1] > peak[1]) return sample;
    return peak;
  }, null);

  return {
    schemaVersion: 1,
    updatedAt: generatedAtUtc,
    updatedAtTs: timestamp,
    source: 'roblox',
    sourceIntervalSeconds: null,
    retention: {
      playerHistorySeconds: PLAYER_HISTORY_WINDOW_SECONDS
    },
    summary: {
      current: [timestamp, players],
      peak7d: peak7d || [timestamp, players]
    },
    series: {
      players: series
    }
  };
}

function normalizePlayerHistoryStore(value, generatedAtUtc) {
  const output = {};
  const cutoffTs = unixTimestamp(generatedAtUtc) - PLAYER_HISTORY_WINDOW_SECONDS;

  for (const [placeId, items] of Object.entries(value || {})) {
    const cleanPlaceId = stringValue(placeId).trim();

    if (!/^\d{3,20}$/.test(cleanPlaceId) || !Array.isArray(items)) {
      continue;
    }

    const series = items
      .map(normalizePlayerSample)
      .filter(sample => sample && sample[0] >= cutoffTs)
      .sort((a, b) => a[0] - b[0]);

    if (series.length) {
      output[cleanPlaceId] = series;
    }
  }

  return output;
}

function normalizePlayerSample(value) {
  if (!Array.isArray(value) || value.length < 2) return null;

  const timestamp = Number(value[0]);
  const players = numberValue(value[1]);

  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  return [Math.floor(timestamp), players];
}

function sortPlayerHistoryStore(value) {
  return Object.keys(value)
    .sort((a, b) => Number(a) - Number(b))
    .reduce((output, placeId) => {
      const series = Array.isArray(value[placeId])
        ? value[placeId]
            .map(normalizePlayerSample)
            .filter(Boolean)
            .sort((a, b) => a[0] - b[0])
        : [];

      if (series.length) {
        output[placeId] = series;
      }

      return output;
    }, {});
}

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

async function writePlaceJs(filePath, placeId, payload) {
  const js = [
    'window.grRobloxGameInfoStatic = window.grRobloxGameInfoStatic || {};',
    `window.grRobloxGameInfoStatic[${JSON.stringify(stringValue(placeId))}] = ${JSON.stringify(payload)};`,
    ''
  ].join('\n');

  await fs.writeFile(filePath, js, 'utf8');
}

async function writeGlobalJs(filePath, globalName, payload) {
  const js = [
    'window.' + globalName + ' = ' + JSON.stringify(payload) + ';',
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

function dateValue(value) {
  const date = new Date(String(value || '').replace(' ', 'T') + 'Z');
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function unixTimestamp(value) {
  const date = new Date(String(value || '').replace(' ', 'T') + 'Z');
  const time = date.getTime();

  if (Number.isFinite(time)) {
    return Math.floor(time / 1000);
  }

  return Math.floor(Date.now() / 1000);
}

function formatUtc(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
