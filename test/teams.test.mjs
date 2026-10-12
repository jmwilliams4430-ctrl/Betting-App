import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { completedGames, parseSummary, rankTeams, buildTeamData } from '../js/teams.js';
import { defenseVsPosition } from '../js/props.js';

const nflStats = LEAGUES.nfl.teamStats;

function summary(home, away, homeScore, awayScore, homeOff, awayOff) {
  const stats = (o) => [
    { name: 'totalYards', displayValue: String(o.yds) },
    { name: 'netPassingYards', displayValue: String(o.pass) },
    { name: 'rushingYards', displayValue: String(o.rush) },
    { name: 'sacksYardsLost', displayValue: `${o.sacked}-20` },
    { name: 'turnovers', displayValue: String(o.to) },
  ];
  return {
    header: { competitions: [{ competitors: [{ team: { abbreviation: home }, score: String(homeScore) }, { team: { abbreviation: away }, score: String(awayScore) }] }] },
    boxscore: { teams: [{ team: { abbreviation: home }, statistics: stats(homeOff) }, { team: { abbreviation: away }, statistics: stats(awayOff) }] },
  };
}

test('completedGames keeps finished non-preseason games, newest first', () => {
  const json = {
    events: [
      { id: '1', date: '2026-09-07T17:00Z', seasonType: { type: 2 }, competitions: [{ status: { type: { completed: true } } }] },
      { id: '2', date: '2026-08-20T17:00Z', seasonType: { type: 1 }, competitions: [{ status: { type: { completed: true } } }] },
      { id: '3', date: '2026-09-14T17:00Z', seasonType: { type: 2 }, competitions: [{ status: { type: { completed: true } } }] },
      { id: '4', date: '2026-10-19T17:00Z', seasonType: { type: 2 }, competitions: [{ status: { type: { completed: false } } }] },
    ],
  };
  assert.deepEqual(completedGames(json).map((g) => g.id), ['3', '1']);
});

test('parseSummary credits each defense with what the other offense did', () => {
  const r = parseSummary(summary('HOU', 'BUF', 20, 27, { yds: 300, pass: 220, rush: 80, sacked: 2, to: 1 }, { yds: 410, pass: 260, rush: 150, sacked: 4, to: 0 }), nflStats);
  assert.equal(r.HOU.opp, 'BUF');
  assert.deepEqual(r.HOU.allowed, { pts: 27, yds: 410, passYds: 260, rushYds: 150, sacks: 4, takeaways: 0 });
  assert.equal(r.BUF.allowed.pts, 20);
  assert.equal(r.BUF.allowed.sacks, 2);
});

test('rankTeams: #1 allows the fewest, but makes the most sacks', () => {
  const teams = {
    A: { n: 1, stats: { pts: 10, yds: 250, passYds: 150, rushYds: 100, sacks: 1, takeaways: 0 }, ranks: {} },
    B: { n: 1, stats: { pts: 30, yds: 400, passYds: 280, rushYds: 120, sacks: 5, takeaways: 3 }, ranks: {} },
  };
  rankTeams(teams, nflStats);
  assert.equal(teams.A.ranks.pts, 1);
  assert.equal(teams.B.ranks.pts, 2);
  assert.equal(teams.B.ranks.sacks, 1);
});

test('buildTeamData averages allowed stats per team from schedules + box scores', async () => {
  const fetchJson = async (url) => {
    if (url.endsWith('/teams?limit=100')) {
      return { sports: [{ leagues: [{ teams: [{ team: { id: '34', abbreviation: 'HOU', displayName: 'Houston Texans' } }, { team: { id: '2', abbreviation: 'BUF', displayName: 'Buffalo Bills' } }] }] }] };
    }
    if (url.includes('/schedule')) {
      const done = { status: { type: { completed: true } } };
      return { events: [1, 2, 3].map((i) => ({ id: `e${i}`, date: `2026-09-0${i}`, seasonType: { type: 2 }, competitions: [done] })) };
    }
    const m = /event=e(\d)/.exec(url);
    const i = Number(m[1]);
    return summary('HOU', 'BUF', 20, 20 + i, { yds: 300, pass: 200, rush: 100, sacked: 2, to: 1 }, { yds: 300 + 30 * i, pass: 200, rush: 100 + 30 * i, sacked: 3, to: 2 });
  };
  const data = await buildTeamData(LEAGUES.nfl, { fetchJson, now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(data.seasonNote, 'this season');
  assert.equal(data.teams.HOU.n, 3);
  assert.equal(data.teams.HOU.stats.rushYds, 160); // (130+160+190)/3
  assert.equal(data.teams.HOU.stats.pts, 22);
  assert.equal(data.teams.BUF.stats.rushYds, 100);
  assert.equal(data.teams.BUF.ranks.rushYds, 1);
  assert.equal(data.teams.HOU.ranks.rushYds, 2);
});

test('defenseVsPosition: share of players who beat their usual against each defense', () => {
  const g = (o, rushYds, s = 2026) => ({ o, rushYds, rushAtt: 15, rec: 2, s });
  const players = [
    // usual (median of all games) = 70
    { id: '1', name: 'A', pos: 'RB', games: [g('HOU', 110), g('HOU', 95), g('DAL', 40), g('KC', 70), g('KC', 70), g('BUF', 60), g('BUF', 75)] },
    // usual = 50
    { id: '2', name: 'B', pos: 'RB', games: [g('HOU', 80), g('DAL', 30), g('DAL', 35), g('KC', 50), g('KC', 50), g('BUF', 55), g('BUF', 45)] },
  ];
  const r = defenseVsPosition(players, LEAGUES.nfl);
  assert.equal(r.season, 2026);
  const hou = r.teams.HOU.RBs.rushYds;
  assert.equal(hou.n, 3);
  assert.equal(hou.overs, 3);
  assert.ok(hou.pct > 0.4);
  assert.equal(hou.of, 4);
  assert.equal(hou.rank, 4); // softest of the four ranked defenses
  const dal = r.teams.DAL.RBs.rushYds;
  assert.equal(dal.overs, 0);
  assert.equal(dal.rank, 1);
});
