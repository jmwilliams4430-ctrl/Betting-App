// ESPN league-wide injury reports for the Matchups tab. Browser + Node.
import { defaultFetchJson } from './espn.js';

// GitHub's runners are sometimes refused by site.api.espn.com; site.web.api serves the same path.
const HOSTS = ['https://site.web.api.espn.com', 'https://site.api.espn.com'];

// Report status -> severity. Probable / active players aren't worth listing.
export function statusLevel(status) {
  const s = String(status || '').trim().toLowerCase();
  if (/^(out|injured reserve|ir\b|suspen|physically unable|pup|non-football)/.test(s)) return 'out';
  if (s.startsWith('doubtful')) return 'doubtful';
  if (s.startsWith('questionable')) return 'q';
  if (s.startsWith('day-to-day') || s === 'dtd') return 'dtd';
  return null;
}

const LEVEL_ORDER = { out: 0, doubtful: 1, q: 2, dtd: 3 };
export const byLevel = (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || String(b.date).localeCompare(String(a.date));

/** ESPN /injuries response -> flat list of listed players (probable/active dropped). */
export function parseInjuries(json) {
  const out = [];
  for (const team of (json && json.injuries) || []) {
    const teamInfo = team.team || {};
    const teamName = team.displayName || teamInfo.displayName || '';
    const teamId = String(team.id || teamInfo.id || '');
    for (const inj of team.injuries || []) {
      const a = inj.athlete || {};
      let id = String(a.id || '');
      if (!id) {
        for (const ln of a.links || []) {
          const m = /\/id\/(\d+)/.exec(ln.href || '');
          if (m) {
            id = m[1];
            break;
          }
        }
      }
      const status = inj.status || (inj.type && inj.type.description) || '';
      const level = statusLevel(status);
      if (!level) continue;
      const comment = inj.shortComment || inj.longComment || '';
      const details = inj.details || {};
      out.push({
        id,
        name: a.displayName || a.fullName || '',
        pos: (a.position && a.position.abbreviation) || '',
        team: (a.team && a.team.abbreviation) || teamInfo.abbreviation || '',
        teamId: String((a.team && a.team.id) || teamId),
        teamName,
        status,
        level,
        part: details.type || (/\(([^)]+)\)/.exec(comment) || [])[1] || '',
        date: inj.date || '',
        returnDate: details.returnDate || '',
      });
    }
  }
  return out;
}

/** The league's current injury report. Never throws; check `ok`. */
export async function fetchInjuries(cfg, { fetchJson = defaultFetchJson, now = new Date() } = {}) {
  const log = [];
  for (const host of HOSTS) {
    try {
      const json = await fetchJson(`${host}/apis/site/v2/sports/${cfg.sport}/${cfg.league}/injuries`, { timeoutMs: 10000, retries: 0 });
      return { league: cfg.key, generatedAt: now.toISOString(), ok: true, list: parseInjuries(json), log };
    } catch (err) {
      log.push(`injuries ${host}: ${err.message}`);
    }
  }
  return { league: cfg.key, generatedAt: now.toISOString(), ok: false, list: [], log };
}

/**
 * Attach a team abbreviation to every report entry, using (in order) the entry's own
 * abbreviation, the tracked player with that id, then the team id / name from team data.
 */
export function injuriesByTeam(list, teams, players) {
  const byId = {};
  const byName = {};
  for (const t of Object.values(teams || {})) {
    if (t.id) byId[String(t.id)] = t.abbr;
    if (t.name) byName[t.name.toLowerCase()] = t.abbr;
  }
  const playerTeam = new Map((players || []).map((p) => [String(p.id), p.team]));
  const out = {};
  for (const inj of list || []) {
    const team = inj.team || playerTeam.get(inj.id) || byId[inj.teamId] || byName[String(inj.teamName).toLowerCase()];
    if (!team) continue;
    (out[team] = out[team] || []).push(inj);
  }
  for (const l of Object.values(out)) l.sort(byLevel);
  return out;
}

/**
 * Tracked players who missed their team's latest game(s) this season but aren't on the
 * injury report now, so they look set to return. -> [{ player, missed }]
 */
export function returningPlayers(players, reportedIds, season) {
  const teamDates = {};
  for (const p of players) {
    for (const g of p.games) {
      if (g.s === season && g.tm && g.d) (teamDates[g.tm] = teamDates[g.tm] || new Set()).add(g.d);
    }
  }
  const out = [];
  for (const p of players) {
    const last = p.games[0];
    if (!last || last.s !== season || reportedIds.has(String(p.id))) continue;
    const missed = [...(teamDates[p.team] || [])].filter((d) => d > last.d).length;
    if (missed >= 1) out.push({ player: p, missed });
  }
  return out;
}
