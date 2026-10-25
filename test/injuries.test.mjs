import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { statusLevel, parseInjuries, fetchInjuries, injuriesByTeam, returningPlayers } from '../js/injuries.js';

const feed = {
  injuries: [
    {
      id: '26',
      displayName: 'Seattle Seahawks',
      injuries: [
        { status: 'Questionable', date: '2026-10-22T18:00Z', athlete: { id: '4430878', displayName: 'Jaxon Smith-Njigba', position: { abbreviation: 'WR' } }, details: { type: 'Ankle' } },
        { status: 'Injured Reserve', date: '2026-09-30T18:00Z', athlete: { displayName: 'Drake Thomas', position: { abbreviation: 'LB' }, links: [{ href: 'https://www.espn.com/nfl/player/_/id/4372016/drake-thomas' }] }, shortComment: 'Thomas (ankle) was placed on IR.' },
        { status: 'Probable', athlete: { id: '1', displayName: 'Fine Player', position: { abbreviation: 'TE' } } },
      ],
    },
  ],
};

test('statusLevel sorts report statuses into out / doubtful / q / dtd and skips the rest', () => {
  assert.equal(statusLevel('Out'), 'out');
  assert.equal(statusLevel('Injured Reserve'), 'out');
  assert.equal(statusLevel('Doubtful'), 'doubtful');
  assert.equal(statusLevel('Questionable'), 'q');
  assert.equal(statusLevel('Day-To-Day'), 'dtd');
  assert.equal(statusLevel('Probable'), null);
  assert.equal(statusLevel('Active'), null);
});

test('parseInjuries reads ids from links and the body part from the comment', () => {
  const list = parseInjuries(feed);
  assert.equal(list.length, 2); // probable player dropped
  assert.deepEqual(
    list.map((x) => [x.id, x.name, x.pos, x.level, x.part, x.teamName]),
    [
      ['4430878', 'Jaxon Smith-Njigba', 'WR', 'q', 'Ankle', 'Seattle Seahawks'],
      ['4372016', 'Drake Thomas', 'LB', 'out', 'ankle', 'Seattle Seahawks'],
    ],
  );
});

test('injuriesByTeam maps team names to abbreviations', () => {
  const teams = { SEA: { abbr: 'SEA', id: '26', name: 'Seattle Seahawks', n: 5, stats: {}, ranks: {} } };
  const byTeam = injuriesByTeam(parseInjuries(feed), teams, []);
  assert.deepEqual(Object.keys(byTeam), ['SEA']);
  assert.equal(byTeam.SEA[0].level, 'out'); // most severe first
});

test('fetchInjuries falls back to the second ESPN host', async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('site.web.api')) throw new Error('HTTP 403');
    return feed;
  };
  const r = await fetchInjuries(LEAGUES.nfl, { fetchJson });
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].startsWith('https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries'));
});

test('returningPlayers flags players who missed recent games and are off the report', () => {
  const g = (d, tm = 'SEA') => ({ d, s: 2026, tm });
  const players = [
    { id: '1', name: 'Starter', team: 'SEA', games: [g('2026-10-15'), g('2026-10-11')] },
    { id: '2', name: 'Back From Injury', team: 'SEA', games: [g('2026-09-27'), g('2026-09-20')] },
    { id: '3', name: 'Still Out', team: 'SEA', games: [g('2026-10-04')] },
    { id: '4', name: 'Last Season Only', team: 'SEA', games: [{ d: '2025-12-28', s: 2025, tm: 'SEA' }] },
  ];
  // Team dates this season: 10-15, 10-11, 10-04, 09-27, 09-20
  const out = returningPlayers(players, new Set(['3']), 2026);
  assert.deepEqual(out.map((r) => [r.player.name, r.missed]), [['Back From Injury', 3]]);
});
