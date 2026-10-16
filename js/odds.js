// Player-prop prices from Kalshi's public trade API. Browser + Node.
//
// Every quote is normalized to our "X+" form: `price` is the YES ask (0-1) exactly as the
// app shows it; `cost` adds Kalshi's taker fee and is what Best Bets compares against.
import { defaultFetchJson } from './espn.js';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

// Kalshi taker fee: 0.07 x P x (1 - P) per contract (Kalshi rounds the whole order up to a cent).
export const kalshiFee = (p) => 0.07 * p * (1 - p);

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

async function fetchKalshiSeries(ticker, marketId, { fetchJson, pace }) {
  const out = [];
  let cursor = '';
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
  return out;
}

// One series first: if Kalshi can't be reached at all (blocked, offline), skip the rest
// instead of waiting on every request. Then the rest run in parallel, or one at a time
// when `pace` is set (the Node builder, which stays under Kalshi's rate limit).
async function fetchKalshi(cfg, { fetchJson, log, pace }) {
  const series = Object.entries(cfg.kalshiSeries || {});
  if (!series.length) return { quotes: [], ok: false };
  const out = [];
  let failed = 0;
  const run = async ([ticker, marketId]) => {
    try {
      out.push(...(await fetchKalshiSeries(ticker, marketId, { fetchJson, pace })));
      return true;
    } catch (err) {
      failed++;
      log.push(`kalshi ${ticker}: ${err.message}`);
      return /HTTP \d/.test(String(err.message)); // an HTTP error means Kalshi answered
    }
  };
  const [first, ...rest] = series;
  if (!(await run(first))) return { quotes: out, ok: false };
  if (pace) for (const item of rest) await run(item);
  else await Promise.all(rest.map(run));
  return { quotes: out, ok: failed < series.length };
}

/** Kalshi player-prop quotes for a league. Never throws; `venues.K` says whether Kalshi answered. */
export async function fetchMarketQuotes(cfg, { fetchJson: baseFetch = defaultFetchJson, now = new Date(), pace = 0 } = {}) {
  const log = [];
  // Prices go stale fast; fail quickly rather than retrying.
  const fetchJson = (url) => baseFetch(url, { timeoutMs: 10000, retries: 0 });
  const k = await fetchKalshi(cfg, { fetchJson, log, pace });
  return {
    league: cfg.key,
    generatedAt: now.toISOString(),
    venues: { K: k.ok },
    quotes: k.quotes,
    log: log.slice(0, 40),
  };
}
