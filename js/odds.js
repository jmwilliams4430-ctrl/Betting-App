// Player-prop prices from prediction markets (Kalshi + Polymarket US). Browser + Node.
//
// Every quote is normalized to our "X+" form: `price` is the YES ask (0-1) exactly as the
// venue shows it; `cost` adds the venue's taker fee and is what Best Bets compares against.
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

// ---------- Polymarket US ----------
// Polymarket US (polymarket.us, the CFTC-regulated app US players use) runs its own exchange
// with its own prices, separate from the international polymarket.com book. Its public
// gateway needs no key and allows browser requests. Player props are "at least N" markets:
//   event slug "nfl-hou-buf-2026-10-12"
//   market { sportsMarketType: "football_player_passing_yards", line: 250,
//            subject: { name: "C.J. Stroud" }, bestAskQuote: { value: "0.64" }, ... }
const PMUS = 'https://gateway.polymarket.us/v1';

// Stat part of sportsMarketType ("passing_yards" -> "passing yards") -> our market id.
// Order matters: combos before their parts.
const PMUS_STATS = {
  football: [
    [/^scrimmage yards$/, 'rushRecYds'],
    [/^passing yards$/, 'passYds'],
    [/^passing touchdowns$/, 'passTd'],
    [/^passing completions$/, 'cmp'],
    [/^interceptions thrown$/, 'int'],
    [/^rushing yards$/, 'rushYds'],
    [/^rushing attempts$/, 'rushAtt'],
    [/^receiving yards$/, 'recYds'],
    [/^receptions$/, 'rec'],
    [/^touchdowns$/, 'anyTd'],
  ],
  basketball: [
    [/points.*rebounds.*assists/, 'pra'],
    [/points.*rebounds/, 'pr'],
    [/points.*assists/, 'pa'],
    [/rebounds.*assists/, 'ra'],
    [/three|3pt|threes/, 'tpm'],
    [/^rebounds$/, 'reb'],
    [/^assists$/, 'ast'],
    [/^steals$/, 'stl'],
    [/^blocks$/, 'blk'],
    [/^points$/, 'pts'],
  ],
};
const PMUS_TITLE = /^(.*?)\s+(\d+)\+\s/;

// Polymarket US taker fee (in effect since 2026-10-07): 0.0695 x P x (1 - P) per contract.
export const polyFee = (p) => 0.0695 * p * (1 - p);

export function parsePolyUsMarket(m, kind, eventSlug, date) {
  const type = String(m.sportsMarketType || '');
  const at = type.indexOf('_player_');
  if (at < 0) return null;
  if (m.closed || m.active === false) return null;
  if (m.status && m.status !== 'MARKET_STATUS_OPEN') return null;
  const statText = type.slice(at + 8).replace(/_/g, ' ');
  const hit = (PMUS_STATS[kind] || []).find(([rx]) => rx.test(statText));
  if (!hit) return null;
  const titled = PMUS_TITLE.exec(m.title || '');
  const name = (m.subject && m.subject.name) || (m.metadata && m.metadata.playerName) || (titled && titled[1]);
  const n = num(m.line) ?? (titled ? Number(titled[2]) : null);
  if (!name || n === null) return null;
  const quote = (q) => (q && typeof q === 'object' ? num(q.value) : num(q));
  const ask = quote(m.bestAskQuote);
  const bid = quote(m.bestBidQuote);
  if (!usable(ask)) return null;
  if (bid !== null && ask - bid > 0.15) return null;
  return {
    v: 'P',
    name: String(name).trim(),
    m: hit[1],
    line: Math.ceil(n), // "250+" (a line given as 249.5 also means 250+)
    price: ask,
    cost: Math.min(0.99, ask + polyFee(ask)),
    date,
    url: `https://polymarket.us/event/${eventSlug}`,
  };
}

async function fetchPolymarket(cfg, { fetchJson, log, now }) {
  if (!cfg.polyTag) return { quotes: [], ok: false };
  const out = [];
  const day = (offset) => new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10);
  const slugRx = new RegExp(`^${cfg.polyTag}-([a-z]+)-([a-z]+)-(\\d{4}-\\d{2}-\\d{2})$`);
  try {
    const list = await fetchJson(
      `${PMUS}/events?tagSlug=${cfg.polyTag}&active=true&closed=false&startDateMin=${day(-1)}T00:00:00Z&startDateMax=${day(9)}T00:00:00Z&limit=100`,
    );
    const events = ((list && list.events) || (Array.isArray(list) ? list : [])).filter((e) => slugRx.test(e.slug || ''));
    for (const ev of events) {
      const date = slugRx.exec(ev.slug)[3];
      let markets = ev.markets;
      if (!Array.isArray(markets) || !markets.length) {
        try {
          const full = await fetchJson(`${PMUS}/events/slug/${encodeURIComponent(ev.slug)}`);
          markets = ((full && full.event) || full || {}).markets || [];
        } catch (err) {
          log.push(`polymarket ${ev.slug}: ${err.message}`);
          markets = [];
        }
      }
      for (const m of markets) {
        const q = parsePolyUsMarket(m, cfg.kind, ev.slug, date);
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
export async function fetchMarketQuotes(cfg, { fetchJson: baseFetch = defaultFetchJson, now = new Date(), pace = 0 } = {}) {
  const log = [];
  // Prices go stale fast; fail quickly rather than retrying.
  const fetchJson = (url) => baseFetch(url, { timeoutMs: 10000, retries: 0 });
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
