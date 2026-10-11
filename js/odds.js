// Player-prop prices from prediction markets (Kalshi + Polymarket). Browser + Node.
//
// Every quote is normalized to our "X+" form: the price (0-1) you'd pay for YES on
// "player gets at least `line`", which is also the market's implied probability.
import { defaultFetchJson } from './espn.js';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';

// Kalshi charges a taker fee of about 7% x P x (1 - P) per contract.
export const kalshiFee = (p) => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const usable = (p) => p !== null && p !== undefined && Number.isFinite(p) && p > 0.02 && p < 0.98;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "Patrick Mahomes II" / "Ja'Marr Chase" / "Amon-Ra St. Brown" -> comparable key
export function nameKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'`’-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Kalshi ----------
// Market shape (public trade API, no key):
//   event_ticker "KXNFLPASSYDS-26OCT12HOUBUF"  (game date, US Eastern)
//   yes_sub_title "C.J. Stroud: 250+"  floor_strike 249.5  strike_type "greater"
//   yes_ask_dollars "0.6400"  yes_bid_dollars "0.6200"
const KALSHI_EVENT = /-(\d{2})([A-Z]{3})(\d{2})/;
const KALSHI_RUNG = /^(.+?):\s*(\d+)\+/;

export function parseKalshiMarket(m, marketId, series) {
  if (m.status && !['active', 'open'].includes(m.status)) return null;
  if (m.strike_type && m.strike_type !== 'greater') return null;
  const rung = KALSHI_RUNG.exec(m.yes_sub_title || m.title || '');
  const ev = KALSHI_EVENT.exec(m.event_ticker || '');
  if (!rung || !ev || !MONTHS[ev[2]]) return null;
  const line = Number(rung[2]);
  const ask = num(m.yes_ask_dollars) ?? (num(m.yes_ask) !== null ? num(m.yes_ask) / 100 : null);
  const bid = num(m.yes_bid_dollars) ?? (num(m.yes_bid) !== null ? num(m.yes_bid) / 100 : null);
  if (!usable(ask)) return null;
  // A wide-open book means the ask isn't a real price yet.
  if (bid !== null && ask - bid > 0.15) return null;
  const date = `20${ev[1]}-${String(MONTHS[ev[2]]).padStart(2, '0')}-${ev[3]}`;
  return {
    v: 'K',
    name: rung[1].trim(),
    m: marketId,
    line,
    price: ask,
    cost: Math.min(0.99, ask + kalshiFee(ask)),
    date,
    url: `https://kalshi.com/markets/${series.toLowerCase()}`,
  };
}

async function fetchKalshi(cfg, { fetchJson, log, pace }) {
  const out = [];
  let failed = 0;
  const series = Object.entries(cfg.kalshiSeries || {});
  for (const [ticker, marketId] of series) {
    let cursor = '';
    try {
      for (let page = 0; page < 10; page++) {
        if (pace) await new Promise((r) => setTimeout(r, pace)); // Kalshi rate-limits bursts
        const json = await fetchJson(`${KALSHI}/markets?series_ticker=${ticker}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        const markets = json.markets || [];
        for (const m of markets) {
          const q = parseKalshiMarket(m, marketId, ticker);
          if (q) out.push(q);
        }
        cursor = json.cursor || '';
        if (!cursor || !markets.length) break;
      }
    } catch (err) {
      failed++;
      log.push(`kalshi ${ticker}: ${err.message}`);
    }
  }
  return { quotes: out, ok: series.length > 0 && failed < series.length };
}

// ---------- Polymarket ----------
// Gamma API events tagged by league; player props live in "<league>-aaa-bbb-YYYY-MM-DD-player-props"
// events whose markets read "Player Name: Passing Yards O/U 249.5" with Over/Under outcomes.
const POLY_Q = /^(.*?):\s*(.+?)\s+O\/U\s+([\d.]+)/i;

const POLY_STATS = {
  football: [
    [/rush.*\+.*rec|scrimmage yards|rushing \+ receiving/i, 'rushRecYds'],
    [/passing yards/i, 'passYds'],
    [/passing touchdowns|pass(ing)? tds/i, 'passTd'],
    [/completions/i, 'cmp'],
    [/interceptions/i, 'int'],
    [/rushing yards/i, 'rushYds'],
    [/rushing attempts|carries/i, 'rushAtt'],
    [/receiving yards/i, 'recYds'],
    [/receptions/i, 'rec'],
  ],
  basketball: [
    [/pts\s*\+\s*reb\s*\+\s*ast|points\s*\+\s*rebounds\s*\+\s*assists|\bpra\b/i, 'pra'],
    [/pts\s*\+\s*reb|points\s*\+\s*rebounds/i, 'pr'],
    [/pts\s*\+\s*ast|points\s*\+\s*assists/i, 'pa'],
    [/reb\s*\+\s*ast|rebounds\s*\+\s*assists/i, 'ra'],
    [/three|3-?point|3pm|threes/i, 'tpm'],
    [/rebounds?/i, 'reb'],
    [/assists?/i, 'ast'],
    [/steals?/i, 'stl'],
    [/blocks?/i, 'blk'],
    [/points?/i, 'pts'],
  ],
};

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

export function parsePolyMarket(m, kind, slug, date) {
  const q = POLY_Q.exec(m.question || m.groupItemTitle || '');
  if (!q || /\bvs\.?\b/i.test(q[1])) return null;
  const hit = (POLY_STATS[kind] || []).find(([rx]) => rx.test(q[2]));
  if (!hit) return null;
  const ou = num(m.line) ?? Number(q[3]);
  const outcomes = asArray(m.outcomes);
  const prices = asArray(m.outcomePrices);
  const overIdx = outcomes.findIndex((o) => /over|yes/i.test(String(o)));
  let ask = num(m.bestAsk);
  // bestBid/bestAsk describe the first outcome; flip when Over is listed second.
  if (overIdx === 1 && num(m.bestBid) !== null) ask = 1 - num(m.bestBid);
  if (!usable(ask) && overIdx >= 0) ask = num(prices[overIdx]);
  if (!usable(ask)) return null;
  return {
    v: 'P',
    name: q[1].trim(),
    m: hit[1],
    line: Math.floor(ou) + 1, // over 249.5 = 250+
    price: ask,
    cost: ask,
    date,
    url: `https://polymarket.com/event/${slug}`,
  };
}

async function fetchPolymarket(cfg, { fetchJson, log, now }) {
  if (!cfg.polyTag) return { quotes: [], ok: false };
  const out = [];
  try {
    const events = await fetchJson(`${GAMMA}/events?closed=false&tag_slug=${cfg.polyTag}&limit=500&order=startDate&ascending=false`);
    const lo = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    const hi = new Date(now.getTime() + 9 * 86400000).toISOString().slice(0, 10);
    const props = (Array.isArray(events) ? events : events.events || []).filter((e) => /-player-props$/.test(e.slug || ''));
    for (const ev of props) {
      const date = (/(\d{4}-\d{2}-\d{2})-player-props$/.exec(ev.slug) || [])[1] || String(ev.startDate || '').slice(0, 10);
      if (date && (date < lo || date > hi)) continue;
      let markets = ev.markets || [];
      if (!markets.length) {
        try {
          markets = (await fetchJson(`${GAMMA}/events/slug/${encodeURIComponent(ev.slug)}`)).markets || [];
        } catch (err) {
          log.push(`polymarket ${ev.slug}: ${err.message}`);
        }
      }
      for (const m of markets) {
        if (m.closed || m.active === false) continue;
        const q = parsePolyMarket(m, cfg.kind, ev.slug, date);
        if (q) out.push(q);
      }
    }
    return { quotes: out, ok: true };
  } catch (err) {
    log.push(`polymarket: ${err.message}`);
    return { quotes: out, ok: false };
  }
}

/** All prediction-market quotes for a league. Never throws; check `ok` per venue. */
export async function fetchMarketQuotes(cfg, { fetchJson = defaultFetchJson, now = new Date(), pace = 0 } = {}) {
  const log = [];
  const [k, p] = await Promise.all([
    fetchKalshi(cfg, { fetchJson, log, pace }),
    fetchPolymarket(cfg, { fetchJson, log, now }),
  ]);
  return {
    league: cfg.key,
    generatedAt: now.toISOString(),
    venues: { K: k.ok, P: p.ok },
    quotes: [...k.quotes, ...p.quotes],
    log: log.slice(0, 40),
  };
}
