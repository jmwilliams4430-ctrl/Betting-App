import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAGUES } from '../js/config.js';
import { parseGamelog, toNum, buildLeagueData, guessSeason } from '../js/espn.js';
import { bestLine, computeRows, lineStats, onePerPlayer, formatNote } from '../js/props.js';

// Shape of site.web.api.espn.com/apis/common/v3/.../athletes/{id}/gamelog
function nflGamelog(season, rows) {
  const names = ['completions', 'passingAttempts', 'passingYards', 'passingTouchdowns', 'interceptions', 'rushingAttempts', 'rushingYards', 'rushingTouchdowns'];
  const events = {};
  const evRows = rows.map((r, i) => {
    const id = `${season}${String(i).padStart(2, '0')}`;
    events[id] = {
      id,
      gameDate: `${season}-${String(9 + Math.floor(i / 4)).padStart(2, '0')}-${String(1 + (i % 4) * 7).padStart(2, '0')}T17:00:00.000+00:00`,
      atVs: i % 2 ? '@' : 'vs',
      opponent: { abbreviation: `T${i}` },
      team: { id: '34', abbreviation: 'HOU' },
      gameResult: 'W',
      score: '24-17',
    };
    return { eventId: id, stats: r.map(String) };
  });
  return {
    filters: [{ name: 'season', value: String(season) }],
    names,
    labels: ['CMP', 'ATT', 'YDS', 'TD', 'INT', 'CAR', 'YDS', 'TD'],
    events,
    seasonTypes: [
      { displayName: `${season} Preseason`, categories: [{ type: 'event', events: [{ eventId: 'pre1', stats: names.map(() => '999') }] }] },
      { displayName: `${season} Regular Season`, categories: [{ type: 'event', events: evRows }, { type: 'total', totals: [] }] },
    ],
  };
}

test('toNum handles made-attempted, commas, dashes and negatives', () => {
  assert.equal(toNum('4-10'), 4);
  assert.equal(toNum('1,234'), 1234);
  assert.equal(toNum('--'), 0);
  assert.equal(toNum('-3'), -3);
  assert.equal(toNum(undefined), 0);
});

test('parseGamelog maps stats by name, skips preseason, sorts newest first', () => {
  const json = nflGamelog(2026, [
    [20, 30, 210, 1, 0, 3, 12, 0],
    [25, 35, 300, 3, 1, 2, 5, 0],
  ]);
  const { season, games } = parseGamelog(json, LEAGUES.nfl);
  assert.equal(season, 2026);
  assert.equal(games.length, 2);
  assert.ok(games[0].t > games[1].t);
  assert.equal(games.find((g) => g.passYds === 300).passTd, 3);
  assert.ok(!games.some((g) => g.passYds === 999));
  assert.equal(games[0].tm, 'HOU');
});

test('parseGamelog handles basketball made-attempted 3PT column', () => {
  const json = {
    names: ['minutes', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'totalRebounds', 'assists', 'points'],
    events: { a: { id: 'a', gameDate: '2026-03-01T00:00Z', opponent: { abbreviation: 'BOS' } } },
    seasonTypes: [{ displayName: '2025-26 Regular Season', categories: [{ type: 'event', events: [{ eventId: 'a', stats: ['34', '4-9', '7', '6', '31'] }] }] }],
  };
  const { season, games } = parseGamelog(json, LEAGUES.nba);
  assert.equal(season, 2026);
  assert.deepEqual([games[0].tpm, games[0].reb, games[0].ast, games[0].pts], [4, 7, 6, 31]);
});

test('lineStats counts streaks and recent misses', () => {
  const st = lineStats([10, 30, 40, 50], 25); // most recent first
  assert.equal(st.hits, 3);
  assert.equal(st.missedLast, 1);
  assert.equal(st.streak, 0);
  assert.equal(formatNote(st), 'Missed last');
});

test('bestLine picks the highest alt line that clears the hit rate', () => {
  const games = [260, 240, 255, 230, 280, 210, 250, 245, 300, 235].map((y) => ({ att: 33, passYds: y, s: 2026 }));
  const passYds = LEAGUES.nfl.markets.find((m) => m.id === 'passYds');
  const r = bestLine({ id: '1', name: 'A B', games }, passYds, { window: 10, minRate: 1, minGames: 5 });
  assert.equal(r.line, 200);
  assert.equal(r.hits, 10);
  const r90 = bestLine({ id: '1', name: 'A B', games }, passYds, { window: 10, minRate: 0.9, minGames: 5 });
  assert.equal(r90.line, 225);
  assert.equal(r90.hits, 9);
});

test('ineligible markets are skipped (no passing props for a receiver)', () => {
  const games = Array.from({ length: 10 }, () => ({ att: 0, passYds: 0, rec: 6, recYds: 70, s: 2026 }));
  const rows = computeRows([{ id: '9', name: 'W R', games }], LEAGUES.nfl.markets, { window: 10, minRate: 0.8, minGames: 5 });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.market.group === 'Receiving'));
  assert.equal(onePerPlayer(rows).length, 1);
});

test('season window only uses the latest season', () => {
  const games = [
    { att: 30, passYds: 300, s: 2026 },
    { att: 30, passYds: 300, s: 2026 },
    { att: 30, passYds: 300, s: 2026 },
    { att: 30, passYds: 100, s: 2025 },
  ];
  const passYds = LEAGUES.nfl.markets.find((m) => m.id === 'passYds');
  const r = bestLine({ id: '1', name: 'A B', games }, passYds, { window: 'season', minRate: 1, minGames: 5 });
  assert.equal(r.n, 3);
  assert.equal(r.line, 300);
});

test('guessSeason follows each league calendar', () => {
  const oct = new Date('2026-10-10T12:00:00Z');
  assert.equal(guessSeason(LEAGUES.nfl, oct), 2026);
  assert.equal(guessSeason(LEAGUES.nba, oct), 2027);
  assert.equal(guessSeason(LEAGUES.wnba, oct), 2026);
  assert.equal(guessSeason(LEAGUES.nfl, new Date('2027-01-15T00:00:00Z')), 2026);
});

test('buildLeagueData discovers players, backfills last season and reads the schedule', async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('/statistics/byathlete')) {
      if (!url.includes('passing')) return { athletes: [] };
      return { athletes: [{ athlete: { id: '100', displayName: 'C.J. Stroud', position: { abbreviation: 'QB' }, team: { abbreviation: 'HOU' } } }] };
    }
    if (url.includes('/scoreboard')) {
      return {
        events: [
          {
            date: '2026-10-11T17:00Z',
            status: { type: { state: 'pre' } },
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', team: { id: '34', abbreviation: 'HOU' }, leaders: [{ name: 'rushingYards', leaders: [{ athlete: { id: '200', displayName: 'Joe Mixon', position: { abbreviation: 'RB' } } }] }] },
                  { homeAway: 'away', team: { id: '2', abbreviation: 'BUF' } },
                ],
              },
            ],
          },
        ],
      };
    }
    if (url.includes('/athletes/100/gamelog')) {
      if (url.includes('season=2025')) return nflGamelog(2025, Array.from({ length: 17 }, () => [22, 33, 240, 1, 1, 3, 10, 0]));
      return nflGamelog(2026, Array.from({ length: 5 }, () => [22, 33, 250, 2, 0, 3, 12, 0]));
    }
    if (url.includes('/athletes/200/gamelog')) throw new Error('HTTP 404');
    throw new Error(`unexpected ${url}`);
  };

  const data = await buildLeagueData(LEAGUES.nfl, { fetchJson, now: new Date('2026-10-10T12:00:00Z') });
  assert.equal(data.players.length, 1, 'player with no game log is dropped');
  const p = data.players[0];
  assert.equal(p.games.length, 22);
  assert.equal(p.games[0].s, 2026);
  assert.equal(data.schedule.HOU.opp, 'BUF');
  assert.equal(data.schedule.HOU.h, 'vs');
  assert.ok(calls.some((u) => u.includes('athletes/200/gamelog')), 'scoreboard leaders are added as players');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(data)));
});

test('gimme lines far below the player median are not offered', () => {
  // RB who runs for ~80 every week; 25+ always hits but no book offers it at real odds.
  const ys = [82, 75, 91, 68, 80, 77, 85, 62, 88, 79];
  const games = ys.map((y) => ({ rushAtt: 18, rushYds: y, s: 2026 }));
  const rushYds = LEAGUES.nfl.markets.find((m) => m.id === 'rushYds');
  const r = bestLine({ id: '1', name: 'R B', games }, rushYds, { window: 10, minRate: 0.9, minGames: 5, floor: 0.75 });
  assert.equal(r.line, 60);
  assert.equal(r.typical, 79.5);
  const strict = bestLine({ id: '1', name: 'R B', games }, rushYds, { window: 10, minRate: 1, minGames: 5, floor: 0.9 });
  assert.equal(strict, null, 'nothing near the main line hits 10/10');
});

test('anytime TD is a yes/no bet and ignores the median floor', () => {
  const games = Array.from({ length: 10 }, (_, i) => ({ rushAtt: 15, rushYds: 70, rushTd: i < 9 ? 1 : 0, recTd: 0, rec: 2, s: 2026 }));
  const anyTd = LEAGUES.nfl.markets.find((m) => m.id === 'anyTd');
  const r = bestLine({ id: '1', name: 'R B', games }, anyTd, { window: 10, minRate: 0.9, minGames: 5, floor: 0.9 });
  assert.equal(r.line, 1);
  assert.equal(r.hits, 9);
});

test('early in a season, last season\'s leaders top up a thin leaderboard', async () => {
  const athlete = (id, team) => ({ athlete: { id, displayName: `Player ${id}`, position: { abbreviation: 'G' }, team: { abbreviation: team } } });
  const seen = [];
  const fetchJson = async (url) => {
    if (url.includes('/statistics/byathlete')) {
      if (url.includes('season=2026')) return { athletes: [athlete('1', 'BOS'), athlete('3', 'LAL'), athlete('4', 'DEN')] };
      return { athletes: [athlete('1', 'BOS'), athlete('2', 'NYK')] }; // opening night only
    }
    if (url.includes('/scoreboard')) return { events: [] };
    const id = /athletes\/(\d+)\/gamelog/.exec(url)[1];
    seen.push(id);
    return {
      filters: [{ name: 'season', value: '2026' }],
      names: ['minutes', 'points'],
      events: { e1: { id: 'e1', gameDate: '2026-04-12T23:00Z', opponent: { abbreviation: 'MIA' }, team: { abbreviation: 'BOS' } } },
      seasonTypes: [{ displayName: '2025-26 Regular Season', categories: [{ type: 'event', events: [{ eventId: 'e1', stats: ['34', '25'] }] }] }],
    };
  };
  const data = await buildLeagueData(LEAGUES.nba, { fetchJson, now: new Date('2026-10-21T12:00:00Z') });
  assert.deepEqual([...new Set(seen)].sort(), ['1', '2', '3', '4']);
  assert.equal(data.players.length, 4);
});

test('a full leaderboard is not mixed with last season', async () => {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (url.includes('/statistics/byathlete')) {
      return { athletes: Array.from({ length: 200 }, (_, i) => ({ athlete: { id: String(i), displayName: `P ${i}` } })) };
    }
    if (url.includes('/scoreboard')) return { events: [] };
    throw new Error('HTTP 404');
  };
  await buildLeagueData(LEAGUES.nba, { fetchJson, now: new Date('2026-12-21T12:00:00Z'), maxPlayers: 1 });
  assert.ok(!urls.some((u) => u.includes('/statistics/byathlete') && u.includes('season=')));
});
