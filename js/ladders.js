// Kalshi NFL ladders and escalators: contracts that pay a slice of $1 based on the
// player's final stat, instead of all-or-nothing. Browser + Node.
//
// Payout rules (Kalshi's custom strikes, checked against 929 settled markets):
//   Ladder yards       0.25c per yard, cap 400 yd      Ladder receptions    5c per catch, cap 20
//   Escalator yards    (y / 200)^3, y floored to 10 yd, cap 200
//   Escalator catches  (n / 14)^3, cap 14
// Payouts are floored to 0.01c.
import { kalshiFee } from './odds.js';
import { sampleGames, median } from './props.js';

const floor4 = (x) => Math.floor(x * 10000 + 1e-9) / 10000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function scalarPayout(kind, stat, value) {
  const v = Number(value) || 0;
  if (kind === 'ladder') return stat === 'rec' ? clamp(v, 0, 20) * 0.05 : clamp(v, 0, 400) * 0.0025;
  if (stat === 'rec') return floor4((clamp(v, 0, 14) / 14) ** 3);
  return floor4((clamp(10 * Math.floor(v / 10), 0, 200) / 200) ** 3);
}

// Stat a ladder price implies (price / per-unit pay); escalators have no simple inverse.
export function impliedStat(kind, stat, price) {
  if (kind !== 'ladder') return null;
  return price / (stat === 'rec' ? 0.05 : 0.0025);
}

/**
 * Score every ladder / escalator quote against the player's games in the sample window.
 * worth = his average payout per game. YES edge = worth - (ask + fee);
 * NO edge = bid - worth - fee (buying NO at 1 - bid pays 1 - payout).
 */
export function scalarRows(players, scalars, nameKey, opts) {
  const byName = new Map(players.map((p) => [nameKey(p.name), p]));
  const minGames = opts.window === 'season' ? Math.min(3, opts.minGames) : opts.minGames;
  const best = new Map();
  for (const q of scalars || []) {
    const player = byName.get(nameKey(q.name));
    if (!player) continue;
    const key = `${player.id}:${q.kind}:${q.stat}`;
    const cur = best.get(key);
    if (!cur || q.date < cur.q.date) best.set(key, { player, q }); // same contract listed for several games: soonest
  }
  const rows = [];
  for (const { player, q } of best.values()) {
    const games = sampleGames(player.games, opts.window);
    if (games.length < minGames) continue;
    const values = games.map((g) => g[q.stat] ?? 0);
    const pays = values.map((v) => scalarPayout(q.kind, q.stat, v));
    const worth = pays.reduce((a, b) => a + b, 0) / pays.length;
    const yesEdge = worth - q.cost;
    const noEdge = q.bid !== null && q.bid > 0 ? q.bid - worth - kalshiFee(q.bid) : -Infinity;
    const side = noEdge > yesEdge ? 'NO' : 'YES';
    rows.push({
      player, q, games, values, pays, worth,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      med: median(values),
      implied: impliedStat(q.kind, q.stat, q.price),
      beat: pays.filter((x) => x > q.price).length,
      yesEdge, noEdge, side, edge: Math.max(yesEdge, noEdge),
    });
  }
  return rows.sort((a, b) => b.edge - a.edge);
}
