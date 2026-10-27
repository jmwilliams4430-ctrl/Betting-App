import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { finishedOnScoreboard, parseSummary, rankTeams, buildTeamData } from '../js/teams.js';
import { defenseVsPosition, usualValue, activePlayers } from '../js/props.js';

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

test('finishedOnScoreboard keeps finished non-preseason games with both teams', () => {
  const comp = (state, home, away) => [{ status: { type: { state } }, competitors: [{ team: { id: '1', abbreviation: home }, score: '24' }, { team: { id: '2', abbreviation: away }, score: { value: 17 } }] }];
  const json = {
    events: [
      { id: '1', date: '2026-09-07T17:00Z', season: { type: 2 }, competitions: comp('post', 'HOU', 'BUF') },
      { id: '2', date: '2026-08-20T17:00Z', season: { type: 1 }, competitions: comp('post', 'HOU', 'DAL') },
      { id: '3', date: '2026-10-19T17:00Z', season: { type: 2 }, competitions: comp('pre', 'KC', 'LV') },
    ],
  };
  const games = finishedOnScoreboard(json);
  assert.deepEqual(games.map((g) => g.id), ['1']);
  assert.equal(games[0].teams.HOU.score, 24);
  assert.equal(games[0].teams.BUF.score, 17);
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

test('buildTeamData finds games week by week and averages what each defense allowed', async () => {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    const wk = /week=(\d+)&dates=(\d+)/.exec(url);
    if (wk) {
      const week = Number(wk[1]);
      if (Number(wk[2]) !== 2026 || week > 3) return { events: [] };
      return {
        events: [
          {
            id: `e${week}`,
            date: `2026-09-0${week}T17:00Z`,
            season: { type: 2 },
            competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: [{ team: { id: '34', abbreviation: 'HOU' }, score: '20' }, { team: { id: '2', abbreviation: 'BUF' }, score: String(20 + week) }] }],
          },
        ],
      };
    }
    const i = Number(/event=e(\d)/.exec(url)[1]);
    return summary('HOU', 'BUF', 20, 20 + i, { yds: 300, pass: 200, rush: 100, sacked: 2, to: 1 }, { yds: 300 + 30 * i, pass: 200, rush: 100 + 30 * i, sacked: 3, to: 2 });
  };
  const data = await buildTeamData(LEAGUES.nfl, { fetchJson, now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(data.seasonNote, 'this season');
  assert.ok(urls.some((u) => u.includes('/scoreboard?seasontype=2&week=1&dates=2026')));
  assert.equal(data.teams.HOU.n, 3);
  assert.equal(data.teams.HOU.stats.rushYds, 160); // (130+160+190)/3
  assert.equal(data.teams.HOU.stats.pts, 22);
  assert.equal(data.teams.BUF.stats.rushYds, 100);
  assert.equal(data.teams.BUF.ranks.rushYds, 1);
  assert.equal(data.teams.HOU.ranks.rushYds, 2);
});

test('buildTeamData (basketball) falls back to the end of last season when this one has no games', async () => {
  const fetchJson = async (url) => {
    const d = /dates=(\d{8})/.exec(url)[1];
    if (d !== '20260413') return { events: [] };
    return {
      events: [{ id: 'n1', date: '2026-04-13T23:00Z', season: { type: 2 }, competitions: [{ status: { type: { completed: true } }, competitors: [{ team: { abbreviation: 'BOS' }, score: '110' }, { team: { abbreviation: 'NYK' }, score: '101' }] }] }],
    };
  };
  const nbaSummary = (url) => ({ boxscore: { teams: [{ team: { abbreviation: 'BOS' }, statistics: [{ name: 'totalRebounds', displayValue: '44' }] }, { team: { abbreviation: 'NYK' }, statistics: [{ name: 'totalRebounds', displayValue: '39' }] }] } });
  const data = await buildTeamData(LEAGUES.nba, {
    fetchJson: (url) => (url.includes('/summary') ? Promise.resolve(nbaSummary(url)) : fetchJson(url)),
    now: new Date('2026-10-12T00:00:00Z'),
  });
  assert.equal(data.seasonNote, 'last season');
  assert.equal(data.teams.BOS.n, 1);
  assert.equal(data.teams.BOS.stats.pts, 101); // score from the scoreboard when the summary has none
  assert.equal(data.teams.BOS.stats.reb, 39);
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
  assert.deepEqual(
    hou.games.map((x) => [x.name, x.v, x.usual]),
    [['A', 110, 70], ['A', 95, 70], ['B', 80, 50]],
  );
  const dal = r.teams.DAL.RBs.rushYds;
  assert.equal(dal.overs, 0);
  assert.equal(dal.rank, 1);
});

test('usualValue uses this season once a player has 3+ games in it', () => {
  const rushYds = LEAGUES.nfl.markets.find((m) => m.id === 'rushYds');
  const last = Array.from({ length: 12 }, () => ({ s: 2025, rushYds: 10 }));
  const starter = { games: [{ s: 2026, rushYds: 92 }, { s: 2026, rushYds: 81 }, { s: 2026, rushYds: 61 }, ...last] };
  assert.equal(usualValue(starter, rushYds, 2026), 81);
  const twoGames = { games: [{ s: 2026, rushYds: 92 }, { s: 2026, rushYds: 81 }, ...last] };
  assert.equal(usualValue(twoGames, rushYds, 2026), 10); // not enough this season yet
});

test('activePlayers drops players who missed their team\'s recent games', () => {
  const p = (name, team, d) => ({ name, team, games: [{ d }] });
  const out = activePlayers([
    p('Starter', 'SEA', '2026-10-11'),
    p('On IR', 'SEA', '2026-09-20'),
    p('Backup QB', 'SEA', '2025-12-28'),
    p('Missed one', 'SEA', '2026-10-04'),
    p('Other team', 'DEN', '2026-10-11'),
  ]).map((x) => x.name);
  assert.deepEqual(out, ['Starter', 'Missed one', 'Other team']);
});

test('buildTeamData (basketball) mixes last night with the end of last season', async () => {
  const game = (id, date, home, away) => ({
    id,
    date: `${date}T23:00Z`,
    season: { type: 2 },
    competitions: [{ status: { type: { completed: true } }, competitors: [{ team: { abbreviation: home }, score: '110' }, { team: { abbreviation: away }, score: '100' }] }],
  });
  const fetchJson = async (url) => {
    if (url.includes('/summary')) {
      return { boxscore: { teams: [{ team: { abbreviation: 'BOS' }, statistics: [{ name: 'totalRebounds', displayValue: '40' }] }, { team: { abbreviation: 'NYK' }, statistics: [{ name: 'totalRebounds', displayValue: '45' }] }] } };
    }
    const d = /dates=(\d{8})/.exec(url)[1];
    if (d === '20261020') return { events: [game('new1', '2026-10-20', 'BOS', 'NYK')] };
    if (d === '20260413') return { events: [game('old1', '2026-04-13', 'BOS', 'NYK')] };
    return { events: [] };
  };
  const data = await buildTeamData(LEAGUES.nba, { fetchJson, now: new Date('2026-10-21T12:00:00Z') });
  assert.match(data.seasonNote, /this season \+ end of last season/);
  assert.equal(data.teams.BOS.n, 2);
});

test('defenseVsPosition (basketball) uses each defense\'s last 10 games across seasons', () => {
  const g = (d, s, pts) => ({ o: 'NYK', d, s, pts, min: 34 });
  const old = Array.from({ length: 12 }, (_, i) => g(`2026-04-${String(13 - i).padStart(2, '0')}`, 2026, 20));
  const players = [{ id: '1', name: 'Guard', pos: 'PG', team: 'BOS', games: [g('2026-10-20', 2027, 30), ...old] }];
  const r = defenseVsPosition(players, LEAGUES.nba);
  const a = r.teams.NYK.PG.pts;
  assert.equal(a.n, 10); // last night + 9 from last season, not just the 1 new game
  assert.equal(a.games[0].d, '2026-10-20');
  assert.equal(r.window, 10);
  assert.equal(r.mixed, true);
});

test('basketball positions: specific ones kept, G / F split by role', async () => {
  const { basketballPosition } = await import('../js/config.js');
  const games = (ast, reb) => Array.from({ length: 5 }, () => ({ ast, reb }));
  assert.equal(basketballPosition({ pos: 'SG', games: games(9, 2) }), 'SG');
  assert.equal(basketballPosition({ pos: 'G', games: games(7.2, 4) }), 'PG');
  assert.equal(basketballPosition({ pos: 'G', games: games(2.5, 3) }), 'SG');
  assert.equal(basketballPosition({ pos: 'F', games: games(2, 9.5) }), 'PF');
  assert.equal(basketballPosition({ pos: 'F', games: games(3, 5) }), 'SF');
  assert.equal(basketballPosition({ pos: 'FC', games: [] }), 'PF');
  assert.equal(basketballPosition({ pos: 'C', games: [] }), 'C');
});
