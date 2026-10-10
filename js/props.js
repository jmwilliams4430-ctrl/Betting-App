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
