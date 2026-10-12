// Team defense numbers for the Matchups tab, from ESPN team schedules + game box scores.
// Browser + Node. Output is plain JSON so it can be cached or pre-built.
import { defaultFetchJson, toNum, guessSeason } from './espn.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

async function pool(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

const scoreOf = (c) => toNum(c && (typeof c.score === 'object' && c.score ? c.score.value ?? c.score.displayValue : c.score));

// Completed regular/post-season games from one team schedule response, newest first.
export function completedGames(json) {
  const out = [];
  for (const ev of (json && json.events) || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const done = (comp.status && comp.status.type && comp.status.type.completed) || (ev.status && ev.status.type && ev.status.type.completed);
    const type = Number((ev.seasonType && ev.seasonType.type) ?? (comp.type && comp.type.id) ?? 2);
    if (!done || type === 1) continue; // 1 = preseason
    out.push({ id: String(ev.id), date: ev.date || comp.date || '' });
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * One game summary -> { ABBR: { opp: 'XYZ', allowed: {stat: n}, forced: {stat: n} } } for both teams.
 * "allowed" for a team = what its opponent's offense put up.
 */
export function parseSummary(json, statDefs) {
  const box = ((json && json.boxscore) || {}).teams || [];
  const comps = ((((json && json.header) || {}).competitions || [])[0] || {}).competitors || [];
  const scores = {};
  for (const c of comps) {
    const abbr = c.team && c.team.abbreviation;
    if (abbr) scores[abbr] = scoreOf(c);
  }
  const offense = {};
  for (const t of box) {
    const abbr = t.team && t.team.abbreviation;
    if (!abbr) continue;
    const byName = new Map((t.statistics || []).map((s) => [s.name, s.displayValue ?? s.value]));
    const row = {};
    for (const d of statDefs) {
      if (d.from === 'score') row[d.id] = scores[abbr];
      else {
        const name = d.names.find((n) => byName.has(n));
        if (name !== undefined) row[d.id] = toNum(byName.get(name));
      }
    }
    offense[abbr] = row;
  }
  const teams = Object.keys(offense);
  if (teams.length !== 2) return {};
  const [a, b] = teams;
  return {
    [a]: { opp: b, allowed: offense[b] },
    [b]: { opp: a, allowed: offense[a] },
  };
}

// Rank teams per stat. Rank 1 = toughest defense: fewest allowed, or most forced
// for stats marked `higherIsTougher` (sacks, takeaways).
export function rankTeams(teams, statDefs) {
  const list = Object.values(teams).filter((t) => t.n > 0);
  for (const d of statDefs) {
    const have = list.filter((t) => Number.isFinite(t.stats[d.id]));
    have.sort((x, y) => (d.higherIsTougher ? y.stats[d.id] - x.stats[d.id] : x.stats[d.id] - y.stats[d.id]));
    have.forEach((t, i) => {
      t.ranks[d.id] = i + 1;
    });
  }
  return list.length;
}

/**
 * Season-to-date defense for every team in the league. Falls back to last season when the
 * current one has barely started (fewer than 3 games for most teams).
 */
export async function buildTeamData(cfg, { fetchJson = defaultFetchJson, now = new Date(), concurrency = 6, onProgress = () => {} } = {}) {
  const log = [];
  const statDefs = cfg.teamStats;
  const base = `${SITE}/${cfg.sport}/${cfg.league}`;
  onProgress({ phase: 'teams', done: 0, total: 0 });

  const teamsJson = await fetchJson(`${base}/teams?limit=100`);
  const teamList = ((((teamsJson.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
  const teams = {};
  for (const { team } of teamList) {
    if (!team || !team.abbreviation) continue;
    teams[team.abbreviation] = {
      id: String(team.id),
      abbr: team.abbreviation,
      name: team.displayName || team.name || team.abbreviation,
      logo: (team.logos && team.logos[0] && team.logos[0].href) || '',
      n: 0,
      stats: {},
      ranks: {},
    };
  }

  // Each team's finished games (most recent `cfg.teamGames`).
  const schedules = {};
  const fetchSchedules = async (season) => {
    await pool(Object.values(teams), concurrency, async (t) => {
      try {
        const json = await fetchJson(`${base}/teams/${t.id}/schedule${season ? `?season=${season}` : ''}`);
        schedules[t.abbr] = completedGames(json).slice(0, cfg.teamGames);
      } catch (err) {
        log.push(`schedule ${t.abbr}: ${err.message}`);
        schedules[t.abbr] = [];
      }
    });
  };
  await fetchSchedules();
  const counts = Object.values(schedules).map((g) => g.length).sort((a, b) => a - b);
  const medianGames = counts.length ? counts[counts.length >> 1] : 0;
  let seasonNote = 'this season';
  if (medianGames < 3) {
    await fetchSchedules(guessSeason(cfg, now) - 1);
    seasonNote = 'last season';
  }

  const eventIds = [...new Set(Object.values(schedules).flat().map((g) => g.id))];
  const wanted = new Map(Object.entries(schedules).map(([abbr, gs]) => [abbr, new Set(gs.map((g) => g.id))]));
  const sums = {};
  let done = 0;
  onProgress({ phase: 'games', done, total: eventIds.length });
  await pool(eventIds, concurrency, async (id) => {
    try {
      const parsed = parseSummary(await fetchJson(`${base}/summary?event=${id}`), statDefs);
      for (const [abbr, row] of Object.entries(parsed)) {
        if (!teams[abbr] || !(wanted.get(abbr) || new Set()).has(id)) continue;
        const acc = (sums[abbr] = sums[abbr] || { n: 0, totals: {} });
        acc.n++;
        for (const [k, v] of Object.entries(row.allowed)) acc.totals[k] = (acc.totals[k] || 0) + v;
      }
    } catch (err) {
      log.push(`summary ${id}: ${err.message}`);
    }
    done++;
    onProgress({ phase: 'games', done, total: eventIds.length });
  });

  for (const [abbr, acc] of Object.entries(sums)) {
    const t = teams[abbr];
    t.n = acc.n;
    for (const [k, v] of Object.entries(acc.totals)) t.stats[k] = v / acc.n;
  }
  rankTeams(teams, statDefs);

  return { league: cfg.key, generatedAt: now.toISOString(), seasonNote, teams, log: log.slice(0, 40) };
}
