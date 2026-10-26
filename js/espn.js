// ESPN public (unofficial) API client + parsers. Works in the browser and in Node 18+.
import { MAX_GAMES } from './config.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports';

// Stop reaching back into older seasons once a player has this many games.
const ENOUGH_GAMES = 15;

export async function defaultFetchJson(url, { timeoutMs = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (/HTTP 4\d\d/.test(String(err.message))) break; // not worth retrying
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// ESPN "season" year for the season in progress (or most recently started) on `now`.
export function guessSeason(cfg, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0 = Jan
  if (cfg.kind === 'football') return m >= 7 ? y : y - 1; // Aug onward = new season
  if (cfg.league === 'wnba') return m >= 4 ? y : y - 1; // May onward
  return m >= 9 ? y + 1 : y; // NBA: 2025-26 season is "2026", starts in October
}

// "4-10" (made-attempted) -> 4, "1,234" -> 1234, "--" -> 0
export function toNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/,/g, '');
  const made = s.match(/^(-?\d+(?:\.\d+)?)-(\d+)/);
  if (made) return Number(made[1]);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function seasonFromText(text) {
  const m = String(text || '').match(/(\d{4})(?:-(\d{2}))?/);
  if (!m) return null;
  return m[2] ? 2000 + Number(m[2]) : Number(m[1]);
}

// Map stat key -> column index. Supports plain `names`, plain `labels` and, when the log declares
// stat groups (categories with counts), `group.name` / `group.LABEL` keys.
function buildIndex(json) {
  const names = Array.isArray(json.names) ? json.names : [];
  const labels = Array.isArray(json.labels) ? json.labels : [];
  const idx = new Map();
  const add = (k, i) => {
    if (k && !idx.has(k)) idx.set(k, i);
  };
  let offset = 0;
  for (const c of Array.isArray(json.categories) ? json.categories : []) {
    const count = Number(c && c.count);
    if (!count) continue;
    for (let i = offset; i < offset + count && i < names.length; i++) {
      add(`${c.name}.${names[i]}`, i);
      add(`${c.name}.${labels[i]}`, i);
    }
    offset += count;
  }
  names.forEach((n, i) => add(n, i));
  labels.forEach((l, i) => add(l, i));
  return idx;
}

function resolveColumns(json, statDefs) {
  const idx = buildIndex(json);
  const cols = {};
  for (const [key, candidates] of Object.entries(statDefs)) {
    const hit = candidates.find((c) => idx.has(c));
    if (hit !== undefined) cols[key] = idx.get(hit);
  }
  return cols;
}

function eventMetaMap(events) {
  const map = new Map();
  const list = Array.isArray(events) ? events : events && typeof events === 'object' ? Object.values(events) : [];
  for (const e of list) {
    if (!e) continue;
    const id = String(e.id ?? e.eventId ?? '');
    if (id) map.set(id, e);
  }
  return map;
}

function homeAway(meta) {
  if (meta.atVs) return meta.atVs === '@' ? '@' : 'vs';
  if (meta.homeTeamId && meta.team && meta.team.id) return String(meta.homeTeamId) === String(meta.team.id) ? 'vs' : '@';
  return '';
}

/**
 * Parse an ESPN athlete game log into compact game rows (most recent first).
 * Preseason / All-Star games are dropped.
 */
export function parseGamelog(json, cfg, requestedSeason = null) {
  const filterSeason = (json.filters || []).find((f) => f && f.name === 'season');
  let season = filterSeason ? Number(filterSeason.value) || null : null;
  if (!season) season = requestedSeason;

  const cols = resolveColumns(json, cfg.stats);
  const meta = eventMetaMap(json.events);
  const rows = [];

  for (const st of Array.isArray(json.seasonTypes) ? json.seasonTypes : []) {
    const stName = String(st.displayName || st.name || '');
    if (/pre[\s-]?season|all[\s-]?star/i.test(stName)) continue;
    const post = /post|playoff/i.test(stName);
    if (!season) season = seasonFromText(stName);
    for (const cat of Array.isArray(st.categories) ? st.categories : []) {
      if (cat.type && cat.type !== 'event') continue;
      for (const ev of Array.isArray(cat.events) ? cat.events : []) {
        const id = String(ev.eventId ?? ev.id ?? '');
        if (id && Array.isArray(ev.stats)) rows.push({ id, stats: ev.stats, post });
      }
    }
  }
  // Simpler shape: stats attached straight to each event.
  if (!rows.length) {
    for (const [id, e] of meta) if (Array.isArray(e.stats)) rows.push({ id, stats: e.stats, post: false });
  }

  const seen = new Set();
  const games = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const m = meta.get(r.id) || {};
    const date = m.gameDate || m.date || '';
    const g = {
      id: r.id,
      d: date ? String(date).slice(0, 10) : '',
      t: date,
      o: (m.opponent && (m.opponent.abbreviation || m.opponent.displayName)) || '',
      h: homeAway(m),
      r: m.gameResult || '',
      sc: m.score || '',
      tm: (m.team && m.team.abbreviation) || '',
      tid: (m.team && m.team.id && String(m.team.id)) || '',
      s: season,
      p: r.post ? 1 : 0,
    };
    for (const [key, i] of Object.entries(cols)) g[key] = toNum(r.stats[i]);
    games.push(g);
  }
  games.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return { season, games, columnsFound: Object.keys(cols) };
}

function gamelogUrl(cfg, id, season) {
  return `${WEB}/${cfg.sport}/${cfg.league}/athletes/${id}/gamelog${qs({ season })}`;
}

// maxGames / enough: the Players tab asks for a full season and at least 20 games.
export async function fetchPlayerGames(cfg, id, { fetchJson = defaultFetchJson, now = new Date(), maxGames = MAX_GAMES, enough = ENOUGH_GAMES } = {}) {
  const first = parseGamelog(await fetchJson(gamelogUrl(cfg, id)), cfg, null);
  let games = first.games;
  let season = first.season || guessSeason(cfg, now);
  for (let tries = 0; games.length < enough && tries < 2; tries++) {
    season -= 1;
    try {
      const older = parseGamelog(await fetchJson(gamelogUrl(cfg, id, season)), cfg, season);
      if (!older.games.length) continue;
      const have = new Set(games.map((g) => g.id));
      games = games.concat(older.games.filter((g) => !have.has(g.id)));
    } catch {
      break;
    }
  }
  games.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return games.slice(0, maxGames);
}

function pickAthlete(a, extra = {}) {
  if (!a || !a.id) return null;
  const pos = a.position && (a.position.abbreviation || a.position.displayName);
  const team = (a.team && a.team.abbreviation) || a.teamAbbreviation || a.teamShortName || extra.team || '';
  const teamId = (a.team && a.team.id) || a.teamId || extra.teamId || '';
  return {
    id: String(a.id),
    name: a.displayName || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' '),
    pos: pos || extra.pos || '',
    team,
    teamId: teamId ? String(teamId) : '',
  };
}

function mergeAthlete(map, p) {
  if (!p || !p.name) return;
  const cur = map.get(p.id);
  if (!cur) return void map.set(p.id, p);
  for (const k of ['pos', 'team', 'teamId']) if (!cur[k] && p[k]) cur[k] = p[k];
}

async function discoverFromLeaderboards(cfg, fetchJson, now, log) {
  const found = new Map();
  for (const d of cfg.discovery) {
    const base = { region: 'us', lang: 'en', contentorigin: 'espn', limit: d.limit, groups: d.groups };
    const board = async (params) => {
      try {
        const json = await fetchJson(`${WEB}/${cfg.sport}/${cfg.league}/statistics/byathlete${qs(params)}`);
        return Array.isArray(json.athletes) ? json.athletes : [];
      } catch (err) {
        log.push(`leaderboard ${d.sort || d.category}: ${err.message}`);
        return [];
      }
    };
    let athletes = await board({ ...base, category: d.category, sort: d.sort });
    // The first days of a season, this season's leaderboard only has players from the few
    // teams that have played. Top it up with last season's leaders so every team is covered.
    if (athletes.length < d.limit * 0.6) {
      athletes = athletes.concat(await board({ ...base, category: d.category, sort: d.sort, season: guessSeason(cfg, now) - 1, seasontype: 2 }));
    }
    if (!athletes.length) athletes = await board({ ...base, category: d.category });
    for (const row of athletes) mergeAthlete(found, pickAthlete(row.athlete || row));
  }
  return found;
}

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// Upcoming games (team -> opponent) plus each team's listed stat leaders.
async function fetchSchedule(cfg, fetchJson, now, log) {
  const urls = [];
  const base = `${SITE}/${cfg.sport}/${cfg.league}/scoreboard`;
  if (cfg.scoreboard.days) {
    for (let i = 0; i < cfg.scoreboard.days; i++) {
      const day = new Date(now.getTime() + i * 86400000);
      urls.push(base + qs({ ...cfg.scoreboard.params, dates: yyyymmdd(day) }));
    }
  } else {
    urls.push(base + qs(cfg.scoreboard.params));
  }

  const schedule = {};
  const leaders = new Map();
  for (const url of urls) {
    let json;
    try {
      json = await fetchJson(url);
    } catch (err) {
      log.push(`scoreboard: ${err.message}`);
      continue;
    }
    for (const ev of json.events || []) {
      const state = ev.status && ev.status.type && ev.status.type.state;
      if (state === 'post') continue;
      const comp = (ev.competitions || [])[0];
      if (!comp) continue;
      const teams = comp.competitors || [];
      for (const c of teams) {
        const other = teams.find((x) => x !== c);
        if (!c.team || !other || !other.team) continue;
        const entry = {
          opp: other.team.abbreviation || other.team.shortDisplayName || '',
          h: c.homeAway === 'home' ? 'vs' : '@',
          t: ev.date || comp.date || '',
          live: state === 'in',
        };
        for (const key of [c.team.abbreviation, c.team.id && `id:${c.team.id}`]) {
          if (key && (!schedule[key] || entry.t < schedule[key].t)) schedule[key] = entry;
        }
        for (const cat of c.leaders || []) {
          for (const l of cat.leaders || []) {
            mergeAthlete(leaders, pickAthlete(l.athlete, { team: c.team.abbreviation, teamId: c.team.id }));
          }
        }
      }
    }
  }
  return { schedule, leaders };
}

/**
 * Build the full dataset for one league: discover players, pull their game logs.
 * Returns plain JSON (no functions) so it can be cached / written to disk.
 */
export async function buildLeagueData(cfg, { fetchJson = defaultFetchJson, now = new Date(), concurrency = 6, maxPlayers = 260, onProgress = () => {} } = {}) {
  const log = [];
  onProgress({ phase: 'players', done: 0, total: 0 });
  const [fromBoards, sched] = await Promise.all([
    discoverFromLeaderboards(cfg, fetchJson, now, log),
    fetchSchedule(cfg, fetchJson, now, log),
  ]);
  const roster = new Map(fromBoards);
  for (const p of sched.leaders.values()) mergeAthlete(roster, p);
  const list = [...roster.values()].slice(0, maxPlayers);

  let done = 0;
  onProgress({ phase: 'games', done, total: list.length });
  const players = (
    await pool(list, concurrency, async (p) => {
      let games = [];
      try {
        games = await fetchPlayerGames(cfg, p.id, { fetchJson, now });
      } catch (err) {
        log.push(`gamelog ${p.name}: ${err.message}`);
      }
      done++;
      onProgress({ phase: 'games', done, total: list.length });
      if (!games.length) return null;
      const latest = games[0];
      return {
        ...p,
        team: latest.tm || p.team,
        teamId: latest.tid || p.teamId,
        games,
      };
    })
  ).filter(Boolean);

  return {
    league: cfg.key,
    generatedAt: now.toISOString(),
    schedule: sched.schedule,
    players,
    log: log.slice(0, 50),
  };
}
