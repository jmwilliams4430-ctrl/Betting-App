import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { parseKalshiMarket, parsePolyMarket, fetchMarketQuotes, nameKey, kalshiFee } from '../js/odds.js';
import { bestBets } from '../js/props.js';

test('Kalshi rung "Player: 250+" parses to a 250+ quote with fee in the cost', () => {
  const q = parseKalshiMarket(
    { event_ticker: 'KXNFLPASSYDS-26OCT12HOUBUF', yes_sub_title: 'C.J. Stroud: 250+', floor_strike: 249.5, strike_type: 'greater', yes_ask_dollars: '0.6400', yes_bid_dollars: '0.6200', status: 'active' },
    'passYds',
    'KXNFLPASSYDS',
  );
  assert.equal(q.name, 'C.J. Stroud');
  assert.equal(q.line, 250);
  assert.equal(q.date, '2026-10-12');
  assert.equal(q.price, 0.64);
  assert.equal(q.cost, 0.64 + kalshiFee(0.64));
});

test('Kalshi markets with no real price or a huge spread are dropped', () => {
  const base = { event_ticker: 'KXNBAPTS-26OCT21LALGSW', yes_sub_title: 'LeBron James: 25+', strike_type: 'greater' };
  assert.equal(parseKalshiMarket({ ...base, yes_ask_dollars: '0.9900' }, 'pts', 'KXNBAPTS'), null);
  assert.equal(parseKalshiMarket({ ...base, yes_ask_dollars: '0.6000', yes_bid_dollars: '0.3000' }, 'pts', 'KXNBAPTS'), null);
});

test('Polymarket "O/U 249.5" becomes 250+ and uses the Over ask', () => {
  const q = parsePolyMarket(
    { question: 'C.J. Stroud: Passing Yards O/U 249.5', outcomes: '["Over","Under"]', outcomePrices: '["0.6","0.4"]', bestAsk: 0.61, bestBid: 0.59 },
    'football',
    'nfl-hou-buf-2026-10-12-player-props',
    '2026-10-12',
  );
  assert.equal(q.m, 'passYds');
  assert.equal(q.line, 250);
  assert.equal(q.price, 0.61);
  const flipped = parsePolyMarket(
    { question: 'Josh Allen: Rushing Yards O/U 29.5', outcomes: ['Under', 'Over'], bestAsk: 0.55, bestBid: 0.5 },
    'football',
    's',
    '2026-10-12',
  );
  assert.equal(flipped.m, 'rushYds');
  assert.equal(flipped.price, 0.5); // Over listed second: buy Over = 1 - Under bid
});

test('basketball combos map before single stats', () => {
  const mk = (stat) => parsePolyMarket({ question: `Nikola Jokic: ${stat} O/U 45.5`, outcomes: ['Over', 'Under'], bestAsk: 0.5 }, 'basketball', 's', '2026-10-21').m;
  assert.equal(mk('Pts + Reb + Ast'), 'pra');
  assert.equal(mk('Points + Rebounds'), 'pr');
  assert.equal(mk('Rebounds'), 'reb');
  assert.equal(mk('Points'), 'pts');
});

test('nameKey matches across punctuation, accents and suffixes', () => {
  assert.equal(nameKey('C.J. Stroud'), nameKey('CJ Stroud'));
  assert.equal(nameKey('Michael Pittman Jr.'), nameKey('Michael Pittman'));
  assert.equal(nameKey('Luka Dončić'), nameKey('Luka Doncic'));
});

test('fetchMarketQuotes survives one venue failing', async () => {
  const fetchJson = async (url) => {
    if (url.includes('kalshi')) throw new Error('HTTP 403');
    return [{ slug: 'nfl-hou-buf-2026-10-12-player-props', markets: [{ question: 'C.J. Stroud: Passing Yards O/U 249.5', outcomes: ['Over', 'Under'], bestAsk: 0.6 }] }];
  };
  const r = await fetchMarketQuotes(LEAGUES.nfl, { fetchJson, now: new Date('2026-10-11T12:00:00Z') });
  assert.equal(r.venues.K, false);
  assert.equal(r.venues.P, true);
  assert.equal(r.quotes.length, 1);
});

test('CFB has no prediction-market lookups', () => {
  assert.equal(LEAGUES.cfb.kalshiSeries, undefined);
  assert.equal(LEAGUES.cfb.polyTag, undefined);
});

test('bestBets ranks by hit rate minus the cheapest price', () => {
  const games = [260, 240, 255, 230, 280, 210, 250, 245, 300, 235].map((y) => ({ att: 33, passYds: y, s: 2026 }));
  const players = [{ id: '1', name: 'C.J. Stroud', games }];
  const quotes = [
    { v: 'K', name: 'C.J. Stroud', m: 'passYds', line: 225, price: 0.6, cost: 0.62, date: '2026-10-12' },
    { v: 'P', name: 'CJ Stroud', m: 'passYds', line: 225, price: 0.65, cost: 0.65, date: '2026-10-12' },
    { v: 'K', name: 'C.J. Stroud', m: 'passYds', line: 275, price: 0.5, cost: 0.52, date: '2026-10-12' },
    { v: 'K', name: 'Someone Else', m: 'passYds', line: 200, price: 0.5, cost: 0.52, date: '2026-10-12' },
  ];
  const rows = bestBets(players, LEAGUES.nfl.markets, quotes, nameKey, { window: 10, minRate: 0.8, minGames: 5 });
  assert.equal(rows.length, 2);
  const top = rows[0];
  assert.equal(top.line, 225); // 9/10 -> 10/12 = .833 vs .62
  assert.equal(top.best.v, 'K');
  assert.equal(top.quotes.length, 2);
  assert.ok(Math.abs(top.edge - (10 / 12 - 0.62)) < 1e-9);
  assert.ok(rows[1].edge < 0); // 275+: 2/10 -> 3/12 = .25 vs .52
});
