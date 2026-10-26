// Every player on every team, for the Players tab search. Browser + Node.
import { defaultFetchJson } from './espn.js';

// Same host order as injuries.js: site.web.api first, site.api as the fallback.
const HOSTS = ['https://site.web.api.espn.com', 'https://site.api.espn.com'];

/** ESPN /teams response -> [{ id, abbr, name }] */
export function parseTeams(json) {
  const out = [];
  for (const sport of (json && json.sports) || []) {
    for (const league of sport.leagues || []) {
      for (const t of league.teams || []) {
        const team = t.team || t;
        if (team && team.id) out.push({ id: String(team.id), abbr: team.abbreviation || '', name: team.displayName || '' });
      }
    }
  }
  return out;
}

/** ESPN /teams/{id}/roster response -> [{ id, name, pos, team }]. Handles grouped and flat lists. */
export function parseRoster(json, team) {
  const out = [];
  const add = (a) => {
    if (!a || !a.id) return;
    out.push({
      id: String(a.id),
      name: a.displayName || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' '),
      pos: (a.position && (a.position.abbreviation || a.position.displayName)) || '',
      team: team.abbr,
      teamId: team.id,
    });
  };
  for (const a of (json && json.athletes) || []) {
    if (Array.isArray(a.items)) a.items.forEach(add);
    else add(a);
  }
  return out;
}

/** All rostered players in the league. Never throws; check `ok`. */
export async function fetchRoster(cfg, { fetchJson = defaultFetchJson, now = new Date(), concurrency = 6 } = {}) {
  const log = [];
  for (const host of HOSTS) {
    const base = `${host}/apis/site/v2/sports/${cfg.sport}/${cfg.league}/teams`;
    let teams;
    try {
      teams = parseTeams(await fetchJson(base, { timeoutMs: 10000, retries: 0 }));
    } catch (err) {
      log.push(`teams ${host}: ${err.message}`);
      continue;
    }
    if (!teams.length) {
      log.push(`teams ${host}: none listed`);
      continue;
    }
    const players = [];
    let next = 0;
    const run = async () => {
      while (next < teams.length) {
        const t = teams[next++];
        try {
          players.push(...parseRoster(await fetchJson(`${base}/${t.id}/roster`, { timeoutMs: 10000, retries: 1 }), t));
        } catch (err) {
          log.push(`roster ${t.abbr}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, teams.length) }, run));
    if (players.length) return { league: cfg.key, generatedAt: now.toISOString(), ok: true, players, log };
  }
  return { league: cfg.key, generatedAt: now.toISOString(), ok: false, players: [], log };
}

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();

/**
 * Players matching `query` by name (every word must start a word of the name) or team.
 * Lists are merged by id, earlier lists win (pass tracked players first).
 */
export function searchPlayers(query, lists, limit = 25) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set();
  const hits = [];
  for (const list of lists) {
    for (const p of list || []) {
      if (seen.has(p.id)) continue;
      const parts = norm(p.name).split(/\s+/);
      const team = norm(p.team);
      const ok = words.every((w) => parts.some((x) => x.startsWith(w)) || (words.length === 1 && team === w));
      if (!ok) continue;
      seen.add(p.id);
      // Last-name hits and players we already have game logs for come first.
      const score = (parts[parts.length - 1].startsWith(words[words.length - 1]) ? 0 : 1) + (p.games ? 0 : 2);
      hits.push({ p, score });
    }
  }
  return hits
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((h) => h.p);
}
