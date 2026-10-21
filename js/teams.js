// Team defense numbers for the Matchups tab, from ESPN scoreboards + game box scores.
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

// Finished regular/post-season games on one scoreboard response.
// -> [{ id, date, teams: { ABBR: { id, name, score } } }]
export function finishedOnScoreboard(json) {
  const out = [];
  for (const ev of (json && json.events) || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const st = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
    if (!(st.completed || st.state === 'post')) continue;
    const seasonType = Number((ev.season && ev.season.type) ?? 2);
    if (seasonType === 1) continue; // preseason
    const teams = {};
    for (const c of comp.competitors || []) {
      const t = c.team || {};
      if (t.abbreviation) teams[t.abbreviation] = { id: String(t.id || ''), name: t.displayName || t.name || t.abbreviation, score: scoreOf(c) };
    }
    if (Object.keys(teams).length === 2) out.push({ id: String(ev.id), date: ev.date || comp.date || '', teams });
  }
  return out;
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * One game summary -> { ABBR: { opp: 'XYZ', allowed: {stat: n}, forced: {stat: n} } } for both teams.
 * "allowed" for a team = what its opponent's offense put up.
 */
export function parseSummary(json, statDefs, fallbackScores = {}) {
  const box = ((json && json.boxscore) || {}).teams || [];
  const comps = ((((json && json.header) || {}).competitions || [])[0] || {}).competitors || [];
  const scores = {};
  for (const c of comps) {
    const abbr = c.team && c.team.abbreviation;
    if (abbr) scores[abbr] = scoreOf(c);
  }
  for (const [abbr, v] of Object.entries(fallbackScores)) if (!(abbr in scores)) scores[abbr] = v;
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
 * Every finished game we want, found through ESPN scoreboards (the same feed that lists
 * upcoming games). Football walks the season week by week; basketball walks back day by
 * day until each team has `cfg.teamGames` games. When the current season has barely
 * started, the end of last season is used instead.
 */
async function findGames(cfg, base, fetchJson, now, log) {
  const found = new Map();
  const add = (json) => {
    const games = finishedOnScoreboard(json);
    for (const g of games) found.set(g.id, g);
    return games.length;
  };
  const perTeam = () => {
    const c = {};
    for (const g of found.values()) for (const t of Object.keys(g.teams)) c[t] = (c[t] || 0) + 1;
    return c;
  };
  const enough = () => {
    const counts = Object.values(perTeam()).sort((a, b) => a - b);
    return counts.length > 0 && counts[counts.length >> 1] >= 3;
  };

  if (cfg.kind === 'football') {
    const walk = async (season) => {
      for (let week = 1; week <= 18; week++) {
        try {
          const n = add(await fetchJson(`${base}/scoreboard?seasontype=2&week=${week}&dates=${season}&limit=100`));
          if (n === 0 && week > 1) break;
        } catch (err) {
          log.push(`scoreboard week ${week}: ${err.message}`);
          break;
        }
      }
    };
    const season = guessSeason(cfg, now);
    await walk(season);
    if (enough()) return { games: [...found.values()], note: 'this season' };
    found.clear();
    await walk(season - 1);
    return { games: [...found.values()], note: 'last season' };
  }

  // Basketball: day-by-day scoreboards, newest first, a week at a time.
  const walkDays = async (from, maxDays) => {
    for (let start = 0; start < maxDays; start += 7) {
      const days = [];
      for (let i = start; i < Math.min(start + 7, maxDays); i++) days.push(new Date(from.getTime() - i * 86400000));
      await Promise.all(
        days.map(async (d) => {
          try {
            add(await fetchJson(`${base}/scoreboard?dates=${ymd(d)}&limit=100`));
          } catch (err) {
            log.push(`scoreboard ${ymd(d)}: ${err.message}`);
          }
        }),
      );
      const counts = Object.values(perTeam());
      if (counts.length && Math.min(...counts) >= cfg.teamGames) break;
    }
  };
  // Each team's last `teamGames` games: this season's first, topped up from the end of
  // last season until the new season has enough of its own.
  await walkDays(new Date(now.getTime() - 86400000), 35);
  const counts = Object.values(perTeam());
  if (counts.length && Math.min(...counts) >= cfg.teamGames) return { games: [...found.values()], note: 'this season' };
  const current = found.size;
  const [mm, dd] = cfg.seasonEnd.split('-').map(Number);
  const year = guessSeason(cfg, now) + (cfg.seasonEndYearOffset || 0);
  await walkDays(new Date(Date.UTC(year, mm - 1, dd, 12)), 35);
  const note = current
    ? `each team's last ${cfg.teamGames} games (this season + end of last season)`
    : 'last season';
  return { games: [...found.values()], note };
}

/** Season-to-date defense for every team in the league. */
export async function buildTeamData(cfg, { fetchJson = defaultFetchJson, now = new Date(), concurrency = 6, onProgress = () => {} } = {}) {
  const log = [];
  const statDefs = cfg.teamStats;
  const base = `${SITE}/${cfg.sport}/${cfg.league}`;
  onProgress({ phase: 'teams', done: 0, total: 0 });

  const { games, note } = await findGames(cfg, base, fetchJson, now, log);
  if (!games.length) log.push('found no finished games on ESPN scoreboards');

  // Each team's most recent `cfg.teamGames` games.
  games.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const teams = {};
  const wanted = {};
  for (const g of games) {
    for (const [abbr, t] of Object.entries(g.teams)) {
      if (!teams[abbr]) teams[abbr] = { id: t.id, abbr, name: t.name, n: 0, stats: {}, ranks: {} };
      const w = (wanted[abbr] = wanted[abbr] || new Set());
      if (w.size < cfg.teamGames) w.add(g.id);
    }
  }
  const needed = games.filter((g) => Object.keys(g.teams).some((a) => wanted[a].has(g.id)));

  const sums = {};
  let done = 0;
  onProgress({ phase: 'games', done, total: needed.length });
  await pool(needed, concurrency, async (g) => {
    try {
      const scores = Object.fromEntries(Object.entries(g.teams).map(([a, t]) => [a, t.score]));
      const parsed = parseSummary(await fetchJson(`${base}/summary?event=${g.id}`), statDefs, scores);
      for (const [abbr, row] of Object.entries(parsed)) {
        if (!teams[abbr] || !wanted[abbr].has(g.id)) continue;
        const acc = (sums[abbr] = sums[abbr] || { n: 0, totals: {}, counts: {} });
        acc.n++;
        for (const [k, v] of Object.entries(row.allowed)) {
          if (!Number.isFinite(v)) continue;
          acc.totals[k] = (acc.totals[k] || 0) + v;
          acc.counts[k] = (acc.counts[k] || 0) + 1;
        }
      }
    } catch (err) {
      log.push(`box score ${g.id}: ${err.message}`);
    }
    done++;
    onProgress({ phase: 'games', done, total: needed.length });
  });

  for (const [abbr, acc] of Object.entries(sums)) {
    const t = teams[abbr];
    t.n = acc.n;
    for (const [k, v] of Object.entries(acc.totals)) t.stats[k] = v / acc.counts[k];
  }
  rankTeams(teams, statDefs);
  if (games.length && !Object.keys(sums).length) log.push(`read ${needed.length} box scores but none had team stats`);

  return { league: cfg.key, generatedAt: now.toISOString(), seasonNote: note, teams, log: log.slice(0, 40) };
}
