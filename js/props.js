// Hit-rate math. Pure functions over the JSON produced by espn.js.

import { DEFAULT_FLOOR } from './config.js';

export const DEFAULT_OPTS = { window: 10, minRate: 0.8, minGames: 5, floor: DEFAULT_FLOOR };

// How many recent games define a player's "typical" number (what books set lines around).
const TYPICAL_GAMES = 20;

export function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Games in the chosen window, most recent first. window: number | 'season'.
export function sampleGames(games, window) {
  if (window === 'season') {
    const s = games.length ? games[0].s : null;
    return games.filter((g) => g.s === s);
  }
  return games.slice(0, window);
}

// Hit summary for one market at one line over a list of values (most recent first).
export function lineStats(values, line) {
  const hitsArr = values.map((v) => v >= line);
  const hits = hitsArr.filter(Boolean).length;
  let streak = 0;
  while (streak < hitsArr.length && hitsArr[streak]) streak++;
  let missedLast = 0;
  while (missedLast < hitsArr.length && !hitsArr[missedLast]) missedLast++;
  return { line, hits, n: values.length, rate: values.length ? hits / values.length : 0, streak, missedLast, hitsArr };
}

/**
 * Best (highest) alt line that still hits at least `minRate` of the time in the window.
 * Lines below `floor` x the player's median are skipped: no book offers them at real odds.
 * Returns null when the player isn't a fit for the market or nothing qualifies.
 */
export function bestLine(player, market, opts = DEFAULT_OPTS) {
  const sample = sampleGames(player.games, opts.window);
  const minGames = opts.window === 'season' ? Math.min(3, opts.minGames) : opts.minGames;
  if (sample.length < minGames) return null;
  if (!market.eligible(player.games.slice(0, 10))) return null;
  const values = sample.map((g) => market.value(g) ?? 0);
  const typical = median(player.games.slice(0, TYPICAL_GAMES).map((g) => market.value(g) ?? 0));
  const floor = market.yesNo ? 0 : (opts.floor ?? DEFAULT_FLOOR) * typical;
  for (let i = market.ladder.length - 1; i >= 0; i--) {
    const line = market.ladder[i];
    if (line < floor) break;
    const st = lineStats(values, line);
    if (st.rate >= opts.minRate) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      return { player, market, values, games: sample, avg, typical, ladderIndex: i, ...st };
    }
  }
  return null;
}

// How close the line sits to the player's typical number (1 = right at the main line).
const lineStrength = (r) => (r.typical > 0 ? r.line / r.typical : 1);

// Higher = better: hit rate first, then sample size, then the line closest to the main line.
export function compareRows(a, b) {
  return b.rate - a.rate || b.hits - a.hits || lineStrength(b) - lineStrength(a) || b.streak - a.streak;
}

export function computeRows(players, markets, opts = DEFAULT_OPTS) {
  const rows = [];
  for (const p of players) {
    for (const m of markets) {
      const r = bestLine(p, m, opts);
      if (r) rows.push(r);
    }
  }
  return rows.sort(compareRows);
}

// Keep only each player's single most reliable prop (rows must already be sorted).
export function onePerPlayer(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.player.id) ? false : (seen.add(r.player.id), true)));
}

export function formatNote(r) {
  if (r.missedLast === 1) return 'Missed last';
  if (r.missedLast > 1) return `Missed last ${r.missedLast}`;
  if (r.streak >= 3 && r.streak < r.n) return `Hit last ${r.streak}`;
  return '';
}

// ---------- Best Bets: game-log hit rate vs prediction-market price ----------

// Price (0-1) -> American odds, e.g. 0.64 -> "-178", 0.4 -> "+150".
export function americanOdds(p) {
  if (!(p > 0 && p < 1)) return '';
  return p >= 0.5 ? `-${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`;
}

// Hit rate pulled slightly toward 50% so tiny samples (5/5) don't look like sure things.
export const smoothedRate = (hits, n) => (hits + 1) / (n + 2);

/**
 * Join market quotes ({v, name, m, line, price, cost, date, url}) to players by name and
 * score each prop: edge = smoothed hit rate - cost of the YES side (fees included).
 */
export function bestBets(players, markets, quotes, nameKey, opts = DEFAULT_OPTS) {
  const byName = new Map(players.map((p) => [nameKey(p.name), p]));
  const byId = new Map(markets.map((m) => [m.id, m]));
  const groups = new Map();
  for (const q of quotes) {
    const player = byName.get(nameKey(q.name));
    const market = byId.get(q.m);
    if (!player || !market) continue;
    const key = `${player.id}:${market.id}:${q.line}`;
    if (!groups.has(key)) groups.set(key, { player, market, line: q.line, byVenue: new Map() });
    const g = groups.get(key);
    const cur = g.byVenue.get(q.v);
    // Same venue listing several games: keep the soonest one.
    if (!cur || q.date < cur.date || (q.date === cur.date && q.cost < cur.cost)) g.byVenue.set(q.v, q);
  }

  const minGames = opts.window === 'season' ? Math.min(3, opts.minGames) : opts.minGames;
  const rows = [];
  for (const g of groups.values()) {
    const games = sampleGames(g.player.games, opts.window);
    if (games.length < minGames) continue;
    const values = games.map((x) => g.market.value(x) ?? 0);
    const st = lineStats(values, g.line);
    const quotesSorted = [...g.byVenue.values()].sort((a, b) => a.cost - b.cost);
    const best = quotesSorted[0];
    const est = smoothedRate(st.hits, st.n);
    const typical = median(g.player.games.slice(0, TYPICAL_GAMES).map((x) => g.market.value(x) ?? 0));
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    rows.push({ ...g, ...st, games, values, avg, typical, est, quotes: quotesSorted, best, edge: est - best.cost });
  }
  return rows.sort((a, b) => b.edge - a.edge || b.rate - a.rate);
}

// ---------- Matchups: how each position group has done against each defense ----------

/**
 * For every defense, every position group and every stat in cfg.dvp: games our tracked
 * players had against that defense this season, their average, how many beat the player's
 * usual (his median over all his logged games) and by how much on average.
 * rank 1 = toughest defense for that group/stat (players fell furthest below their usual).
 */
export function defenseVsPosition(players, cfg, minGames = 3) {
  const markets = new Map(cfg.markets.map((m) => [m.id, m]));
  const groupOf = (pos) => {
    const g = cfg.positionGroups.find((x) => x.match.includes(String(pos || '').toUpperCase()));
    return g ? g.label : null;
  };
  let season = -Infinity;
  for (const p of players) if (p.games.length && p.games[0].s > season) season = p.games[0].s;

  const teams = {};
  for (const p of players) {
    const group = groupOf(p.pos);
    const ids = (cfg.dvp || {})[group];
    if (!ids) continue;
    for (const id of ids) {
      const m = markets.get(id);
      if (!m) continue;
      const usual = median(p.games.map((g) => m.value(g) ?? 0));
      if (!(usual > 0)) continue;
      for (const g of p.games) {
        if (g.s !== season || !g.o) continue;
        const v = m.value(g) ?? 0;
        const byGroup = (teams[g.o] = teams[g.o] || {});
        const byStat = (byGroup[group] = byGroup[group] || {});
        const a = (byStat[id] = byStat[id] || { n: 0, sum: 0, overs: 0, diff: 0 });
        a.n++;
        a.sum += v;
        if (v > usual) a.overs++;
        a.diff += (v - usual) / usual;
      }
    }
  }

  for (const [group, ids] of Object.entries(cfg.dvp || {})) {
    for (const id of ids) {
      const ranked = [];
      for (const t of Object.values(teams)) {
        const a = t[group] && t[group][id];
        if (!a) continue;
        a.avg = a.sum / a.n;
        a.pct = a.diff / a.n;
        if (a.n >= minGames) ranked.push(a);
      }
      ranked.sort((x, y) => x.pct - y.pct);
      ranked.forEach((a, i) => {
        a.rank = i + 1;
        a.of = ranked.length;
      });
    }
  }
  return { season: Number.isFinite(season) ? season : null, teams };
}
