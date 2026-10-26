import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { parseTeams, parseRoster, fetchRoster, searchPlayers } from '../js/roster.js';
import { fetchPlayerGames } from '../js/espn.js';

const teamsJson = { sports: [{ leagues: [{ teams: [{ team: { id: '25', abbreviation: 'SF', displayName: 'San Francisco 49ers' } }, { team: { id: '1', abbreviation: 'ATL', displayName: 'Atlanta Falcons' } }] }] }] };

test('parseTeams and parseRoster read grouped (football) and flat (basketball) rosters', () => {
  assert.deepEqual(parseTeams(teamsJson).map((t) => t.abbr), ['SF', 'ATL']);
  const grouped = parseRoster(
    { athletes: [{ position: 'offense', items: [{ id: '4361741', displayName: 'Brock Purdy', position: { abbreviation: 'QB' } }] }, { position: 'defense', items: [{ id: '9', displayName: 'Nick Bosa', position: { abbreviation: 'DE' } }] }] },
    { id: '25', abbr: 'SF' },
  );
  assert.deepEqual(grouped.map((p) => [p.name, p.pos, p.team]), [['Brock Purdy', 'QB', 'SF'], ['Nick Bosa', 'DE', 'SF']]);
  const flat = parseRoster({ athletes: [{ id: '3136776', displayName: 'Stephen Curry', position: { abbreviation: 'PG' } }] }, { id: '9', abbr: 'GS' });
  assert.equal(flat[0].team, 'GS');
});

test('fetchRoster walks every team and falls back to the second host', async () => {
  const fetchJson = async (url) => {
    if (url.startsWith('https://site.web.api.espn.com')) throw new Error('HTTP 403');
    if (url.endsWith('/teams')) return teamsJson;
    const id = /teams\/(\d+)\/roster/.exec(url)[1];
    return { athletes: [{ id: `p${id}`, displayName: `Player ${id}` }] };
  };
  const r = await fetchRoster(LEAGUES.nfl, { fetchJson });
  assert.equal(r.ok, true);
  assert.deepEqual(r.players.map((p) => p.team).sort(), ['ATL', 'SF']);
  assert.match(r.log[0], /403/);
});

test('searchPlayers matches word starts, accents and teams; tracked players win', () => {
  const tracked = [{ id: '1', name: 'Christian McCaffrey', team: 'SF', games: [] }];
  const roster = [
    { id: '1', name: 'Christian McCaffrey', team: 'SF' },
    { id: '2', name: 'Christian Kirk', team: 'SF' },
    { id: '3', name: 'Nikola Jokić', team: 'DEN' },
  ];
  assert.deepEqual(searchPlayers('christian', [tracked, roster]).map((p) => p.id), ['1', '2']);
  assert.ok(searchPlayers('mcc', [tracked, roster])[0].games, 'tracked copy is returned');
  assert.equal(searchPlayers('jokic', [roster])[0].id, '3');
  assert.deepEqual(searchPlayers('sf', [roster]).map((p) => p.id).sort(), ['1', '2']);
  assert.deepEqual(searchPlayers('', [roster]), []);
});

test('fetchPlayerGames can return a full season', async () => {
  const events = {};
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const id = `e${i}`;
    events[id] = { id, gameDate: `2027-01-${String(1 + (i % 28)).padStart(2, '0')}T0${i % 10}:00Z`, opponent: { abbreviation: 'BOS' } };
    rows.push({ eventId: id, stats: ['30', String(i)] });
  }
  const json = { filters: [{ name: 'season', value: '2027' }], names: ['minutes', 'points'], events, seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ type: 'event', events: rows }] }] };
  const fetchJson = async () => json;
  assert.equal((await fetchPlayerGames(LEAGUES.nba, '1', { fetchJson })).length, 25);
  assert.equal((await fetchPlayerGames(LEAGUES.nba, '1', { fetchJson, maxGames: 100, enough: 20 })).length, 40);
});
