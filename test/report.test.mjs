import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { matchupReport } from '../js/report.js';

const opps = ['DEN', 'LAC', 'LV', 'MIA'];
const games = (team, gen) =>
  Array.from({ length: 4 }, (_, i) => ({ id: `${team}${i}`, d: `2026-10-${String(20 - i * 7).padStart(2, '0')}`, t: `2026-10-${String(20 - i * 7).padStart(2, '0')}T20:00Z`, o: opps[i], h: 'vs', tm: team, s: 2026, p: 0, ...gen(i) }));

test('matchupReport lists each game with defense ranks, players and injuries', () => {
  const data = {
    generatedAt: '2026-10-25T20:00:00Z',
    schedule: { KC: { opp: 'SEA', h: '@', t: '2026-10-26T00:20:00Z' }, SEA: { opp: 'KC', h: 'vs', t: '2026-10-26T00:20:00Z' } },
    players: [
      { id: '9', name: 'Kenneth Walker III', pos: 'RB', team: 'KC', games: games('KC', (i) => ({ rushAtt: 20, rushYds: [173, 128, 70, 177][i], rec: 3, recYds: 20 })) },
      { id: '1', name: 'Xavier Worthy', pos: 'WR', team: 'KC', games: games('KC', (i) => ({ rec: 4, recYds: [47, 22, 52, 31][i] })) },
    ],
  };
  const teams = {
    seasonNote: '2026 season',
    teams: { SEA: { id: '26', abbr: 'SEA', name: 'Seattle Seahawks', n: 6, stats: { pts: 20.3, yds: 237.3, passYds: 141.3, rushYds: 96, sacks: 2.7, takeaways: 1.8 }, ranks: { pts: 8, yds: 1, passYds: 1, rushYds: 9, sacks: 9, takeaways: 3 } } },
  };
  const injuries = { ok: true, generatedAt: '2026-10-25T19:00:00Z', list: [{ id: '1', name: 'Xavier Worthy', pos: 'WR', team: 'KC', level: 'q', part: 'Ankle', date: '2026-10-23' }] };
  const text = matchupReport(LEAGUES.nfl, data, teams, injuries).join('\n');
  assert.match(text, /=== KC @ SEA Sun, 10\/25, 8:20 PM ET ===/);
  assert.match(text, /Yards allowed 237\.3 \(#1\)/);
  assert.match(text, /Kenneth Walker III RB: Rush Yds usual 150\.5, L10 173 128 70 177/);
  assert.match(text, /Xavier Worthy WR \[Q\]/);
  assert.match(text, /Injuries KC offense: Q Xavier Worthy \(WR, Ankle\)/);
  assert.match(text, /Defense: not available/, 'KC defense numbers are missing in this fixture');
  assert.doesNotThrow(() => matchupReport(LEAGUES.nba, { schedule: {}, players: [] }, null, null));
});
