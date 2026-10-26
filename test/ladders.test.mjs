import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { scalarPayout, impliedStat, scalarRows } from '../js/ladders.js';
import { fetchMarketQuotes, parseScalarMarket, scalarName, nameKey, kalshiFee } from '../js/odds.js';

test('payout rules match Kalshi: linear ladders, cubic escalators in 10-yard steps', () => {
  assert.equal(scalarPayout('ladder', 'recYds', 100), 0.25);
  assert.equal(scalarPayout('ladder', 'rushYds', -4), 0);
  assert.equal(scalarPayout('ladder', 'rec', 6), 0.30000000000000004);
  assert.equal(scalarPayout('ladder', 'rec', 25), 1);
  assert.equal(scalarPayout('escalator', 'recYds', 69), 0.027); // floored to 60 yds: (60/200)^3
  assert.equal(scalarPayout('escalator', 'rushYds', 165), 0.512); // 160 yds; a 165-yd game settled at $0.51
  assert.equal(scalarPayout('escalator', 'recYds', 250), 1);
  assert.equal(scalarPayout('escalator', 'rec', 7), 0.125);
  assert.ok(Math.abs(impliedStat('ladder', 'recYds', 0.28) - 112) < 1e-9);
  assert.equal(impliedStat('escalator', 'recYds', 0.05), null);
});

test('ladder players come from the yes/no markets sharing the ticker code, else the title', () => {
  const names = new Map([['26OCT26DALPHI-DALCLAMB88', 'CeeDee Lamb']]);
  const spec = { kind: 'ladder', stat: 'recYds' };
  const m = { ticker: 'KXNFLLADDERRECYDS-26OCT26DALPHI-DALCLAMB88', event_ticker: 'KXNFLLADDERRECYDS-26OCT26DALPHI', title: 'Receiving yards ladder', yes_ask_dollars: '0.2400', yes_bid_dollars: '0.2300' };
  const q = parseScalarMarket(m, spec, 'KXNFLLADDERRECYDS', names);
  assert.deepEqual([q.name, q.kind, q.stat, q.price, q.bid, q.date], ['CeeDee Lamb', 'ladder', 'recYds', 0.24, 0.23, '2026-10-26']);
  assert.equal(scalarName({ yes_sub_title: 'George Pickens: Receiving Yards Ladder' }), 'George Pickens');
  assert.equal(scalarName({ title: 'Escalator' }), '');
  assert.equal(parseScalarMarket({ ...m, ticker: 'X-Y-Z', title: 'Escalator' }, spec, 'S', names), null);
});

test('scalarRows values each contract on the sample and picks the better side', () => {
  const games = [120, 90, 100, 110, 80].map((y) => ({ recYds: y, rec: 6, s: 2026 }));
  const players = [{ id: '1', name: 'CeeDee Lamb', team: 'DAL', games }];
  const scalars = [
    { v: 'K', kind: 'ladder', stat: 'recYds', name: 'CeeDee Lamb', price: 0.2, bid: 0.19, cost: 0.2 + kalshiFee(0.2), date: '2026-10-26' },
    { v: 'K', kind: 'ladder', stat: 'rec', name: 'CeeDee Lamb', price: 0.45, bid: 0.44, cost: 0.45 + kalshiFee(0.45), date: '2026-10-26' },
  ];
  const rows = scalarRows(players, scalars, nameKey, { window: 10, minGames: 5 });
  const yds = rows.find((r) => r.q.stat === 'recYds');
  assert.equal(yds.worth, 0.25); // avg 100 yds
  assert.equal(yds.side, 'YES');
  assert.ok(Math.abs(yds.edge - (0.25 - 0.2 - kalshiFee(0.2))) < 1e-12);
  assert.equal(yds.implied, 80);
  const rec = rows.find((r) => r.q.stat === 'rec');
  assert.equal(rec.side, 'NO'); // worth 30c, bid 44c
  assert.ok(Math.abs(rec.edge - (0.44 - 0.3 - kalshiFee(0.44))) < 1e-12);
  assert.equal(rows[0].q.stat, 'rec', 'best edge first');
});

test('fetchMarketQuotes adds NFL ladders named from the yes/no markets', async () => {
  const fetchJson = async (url) => {
    const ticker = /series_ticker=(\w+)/.exec(url)[1];
    if (ticker === 'KXNFLRECYDS') {
      return { markets: [{ ticker: 'KXNFLRECYDS-26OCT26DALPHI-DALGPICKENS14-60', event_ticker: 'KXNFLRECYDS-26OCT26DALPHI', yes_sub_title: 'George Pickens: 60+', strike_type: 'greater', yes_ask_dollars: '0.5700', yes_bid_dollars: '0.5600' }] };
    }
    if (ticker === 'KXNFLESCALATORRECYDS') {
      return { markets: [{ ticker: 'KXNFLESCALATORRECYDS-26OCT26DALPHI-DALGPICKENS14', event_ticker: 'KXNFLESCALATORRECYDS-26OCT26DALPHI', title: 'Escalator', yes_ask_dollars: '0.0480', yes_bid_dollars: '0.0440' }] };
    }
    return { markets: [] };
  };
  const r = await fetchMarketQuotes(LEAGUES.nfl, { fetchJson });
  assert.equal(r.quotes.length, 1);
  assert.deepEqual(r.scalars.map((q) => [q.name, q.kind, q.stat, q.price]), [['George Pickens', 'escalator', 'recYds', 0.048]]);
  assert.ok(r.log.some((l) => l.startsWith('ladder sample KXNFLESCALATORRECYDS')));
});
