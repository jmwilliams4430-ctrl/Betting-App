import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { parseKalshiMarket, parsePolyUsMarket, fetchMarketQuotes, nameKey, kalshiFee, polyFee } from '../js/odds.js';
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
  assert.ok(Math.abs(q.cost - (0.64 + kalshiFee(0.64))) < 1e-12);
});

test('Kalshi markets with no real price or a huge spread are dropped', () => {
  const base = { event_ticker: 'KXNBAPTS-26OCT21LALGSW', yes_sub_title: 'LeBron James: 25+', strike_type: 'greater' };
  assert.equal(parseKalshiMarket({ ...base, yes_ask_dollars: '0.9900' }, 'pts', 'KXNBAPTS'), null);
  assert.equal(parseKalshiMarket({ ...base, yes_ask_dollars: '0.6000', yes_bid_dollars: '0.3000' }, 'pts', 'KXNBAPTS'), null);
});

test('Polymarket US "250+" market uses the app price, with the fee only in the cost', () => {
  const q = parsePolyUsMarket(
    {
      sportsMarketType: 'football_player_passing_yards',
      line: 250,
      title: 'C.J. Stroud 250+ Passing Yards',
      subject: { name: 'C.J. Stroud' },
      bestAskQuote: { value: '0.64', currency: 'USD' },
      bestBidQuote: { value: '0.62', currency: 'USD' },
      status: 'MARKET_STATUS_OPEN',
    },
    'football',
    'nfl-hou-buf-2026-10-12',
    '2026-10-12',
  );
  assert.equal(q.name, 'C.J. Stroud');
  assert.equal(q.m, 'passYds');
  assert.equal(q.line, 250);
  assert.equal(q.price, 0.64);
  assert.ok(Math.abs(q.cost - (0.64 + polyFee(0.64))) < 1e-12);
  assert.equal(q.url, 'https://polymarket.us/event/nfl-hou-buf-2026-10-12');
});

test('Polymarket US: name from the title, closed and one-sided markets dropped, non-player markets ignored', () => {
  const base = { sportsMarketType: 'football_player_rushing_yards', line: 60, title: 'Josh Allen 60+ Rushing Yards', bestAskQuote: { value: '0.30' } };
  assert.equal(parsePolyUsMarket(base, 'football', 's', 'd').name, 'Josh Allen');
  assert.equal(parsePolyUsMarket({ ...base, status: 'MARKET_STATUS_CLOSED' }, 'football', 's', 'd'), null);
  assert.equal(parsePolyUsMarket({ ...base, bestAskQuote: { value: '0.30' }, bestBidQuote: { value: '0.05' } }, 'football', 's', 'd'), null);
  assert.equal(parsePolyUsMarket({ ...base, sportsMarketType: 'football_game_moneyline' }, 'football', 's', 'd'), null);
  assert.equal(parsePolyUsMarket({ ...base, sportsMarketType: 'football_player_fantasy_points_ppr' }, 'football', 's', 'd'), null);
  assert.equal(parsePolyUsMarket({ ...base, sportsMarketType: 'football_player_touchdowns', line: 1 }, 'football', 's', 'd').m, 'anyTd');
});

test('basketball combos map before single stats', () => {
  const mk = (type) =>
    parsePolyUsMarket({ sportsMarketType: `basketball_player_${type}`, line: 30, subject: { name: 'Nikola Jokic' }, bestAskQuote: { value: '0.5' } }, 'basketball', 's', 'd')?.m;
  assert.equal(mk('points_rebounds_assists'), 'pra');
  assert.equal(mk('points_rebounds'), 'pr');
  assert.equal(mk('rebounds'), 'reb');
  assert.equal(mk('points'), 'pts');
  assert.equal(mk('three_pointers_made'), 'tpm');
});

test('nameKey matches across punctuation, accents and suffixes', () => {
  assert.equal(nameKey('C.J. Stroud'), nameKey('CJ Stroud'));
  assert.equal(nameKey('Michael Pittman Jr.'), nameKey('Michael Pittman'));
  assert.equal(nameKey('Luka Dončić'), nameKey('Luka Doncic'));
});

test('fetchMarketQuotes survives one venue failing', async () => {
  const fetchJson = async (url) => {
    if (url.includes('kalshi')) throw new Error('HTTP 403');
    assert.ok(url.startsWith('https://gateway.polymarket.us/v1/events?tagSlug=nfl'), url);
    return {
      events: [
        { slug: 'nfl-hou-buf-2026-10-12', markets: [{ sportsMarketType: 'football_player_passing_yards', line: 250, subject: { name: 'C.J. Stroud' }, bestAskQuote: { value: '0.6' } }] },
        { slug: 'nfl-hou-buf-2026-10-12-something-else', markets: [] },
      ],
    };
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
