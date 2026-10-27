// League + prop market definitions. Shared by the browser app and the Node data builder.

// How many recent games we keep per player (covers the "L20" window plus a little slack).
export const MAX_GAMES = 25;

// Books hang their main line near a player's median, and alt lines far below it either
// aren't offered or pay nothing. A line must be at least this fraction of the player's
// median (last 20 games) to be shown.
export const LINE_FLOORS = [
  { value: 0.9, label: 'Near main line' },
  { value: 0.75, label: 'Alt lines' },
  { value: 0.6, label: 'Deep alts' },
];
export const DEFAULT_FLOOR = 0.75;

// Raw per-game stats we pull out of an ESPN game log. Each entry lists candidate keys:
// ESPN stat `names` first, then `category.LABEL` fallbacks for logs that split stats into groups.
const FOOTBALL_STATS = {
  cmp: ['completions', 'passing.completions', 'passing.CMP'],
  att: ['passingAttempts', 'passing.passingAttempts', 'passing.ATT'],
  passYds: ['passingYards', 'passing.passingYards', 'passing.YDS'],
  passTd: ['passingTouchdowns', 'passing.passingTouchdowns', 'passing.TD'],
  int: ['interceptions', 'passing.interceptions', 'passing.INT'],
  rushAtt: ['rushingAttempts', 'rushing.rushingAttempts', 'rushing.CAR', 'rushing.ATT'],
  rushYds: ['rushingYards', 'rushing.rushingYards', 'rushing.YDS'],
  rushTd: ['rushingTouchdowns', 'rushing.rushingTouchdowns', 'rushing.TD'],
  rec: ['receptions', 'receiving.receptions', 'receiving.REC'],
  recYds: ['receivingYards', 'receiving.receivingYards', 'receiving.YDS'],
  recTd: ['receivingTouchdowns', 'receiving.receivingTouchdowns', 'receiving.TD'],
  tgt: ['receivingTargets', 'receiving.receivingTargets', 'receiving.TGTS', 'receiving.TGT'],
};

const BASKETBALL_STATS = {
  min: ['minutes', 'MIN'],
  pts: ['points', 'PTS'],
  reb: ['totalRebounds', 'rebounds', 'REB'],
  ast: ['assists', 'AST'],
  stl: ['steals', 'STL'],
  blk: ['blocks', 'BLK'],
  tpm: [
    'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
    'threePointFieldGoalsMade',
    'threePointsMade',
    '3PT',
  ],
};

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const avgOf = (games, key) => avg(games.map((g) => g[key] ?? 0));

const isPasser = (g) => avgOf(g, 'att') >= 15;
const isRusher = (g) => avgOf(g, 'rushAtt') >= 3;
const isCatcher = (g) => avgOf(g, 'rec') >= 1.5;
const isRotation = (g) => avgOf(g, 'min') >= 18;

// value(game) -> number, eligible(games) -> bool, ladder = sportsbook-style alt lines we test ("X+").
// yesNo markets (anytime TD) are a single real bet, so they skip the "near the player's median" floor.
const FOOTBALL_MARKETS = [
  { id: 'passYds', label: 'Pass Yds', group: 'Passing', ladder: [175, 200, 225, 250, 275, 300, 325, 350], value: (s) => s.passYds, eligible: isPasser },
  { id: 'passTd', label: 'Pass TD', group: 'Passing', ladder: [1, 2, 3], value: (s) => s.passTd, eligible: isPasser },
  { id: 'cmp', label: 'Completions', group: 'Passing', ladder: [15, 18, 20, 22, 25, 28, 30], value: (s) => s.cmp, eligible: isPasser },
  { id: 'int', label: 'INT Thrown', group: 'Passing', ladder: [1], value: (s) => s.int, eligible: isPasser },
  { id: 'rushYds', label: 'Rush Yds', group: 'Rushing', ladder: [20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150], value: (s) => s.rushYds, eligible: isRusher },
  { id: 'rushAtt', label: 'Rush Att', group: 'Rushing', ladder: [10, 12, 14, 16, 18, 20, 22, 25], value: (s) => s.rushAtt, eligible: (g) => avgOf(g, 'rushAtt') >= 8 },
  { id: 'rec', label: 'Receptions', group: 'Receiving', ladder: [2, 3, 4, 5, 6, 7, 8, 9, 10], value: (s) => s.rec, eligible: isCatcher },
  { id: 'recYds', label: 'Rec Yds', group: 'Receiving', ladder: [20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150], value: (s) => s.recYds, eligible: isCatcher },
  { id: 'rushRecYds', label: 'Rush+Rec Yds', group: 'Rushing', ladder: [40, 50, 60, 70, 80, 90, 100, 125, 150], value: (s) => (s.rushYds ?? 0) + (s.recYds ?? 0), eligible: (g) => isRusher(g) && avgOf(g, 'rec') >= 1 && !isPasser(g) },
  { id: 'anyTd', label: 'Anytime TD', group: 'Touchdowns', ladder: [1, 2], yesNo: true, value: (s) => (s.rushTd ?? 0) + (s.recTd ?? 0), eligible: (g) => !isPasser(g) && (isRusher(g) || isCatcher(g)) },
];

const BASKETBALL_MARKETS = [
  { id: 'pts', label: 'Points', group: 'Scoring', ladder: [10, 15, 20, 25, 30, 35, 40, 45], value: (s) => s.pts, eligible: isRotation },
  { id: 'reb', label: 'Rebounds', group: 'Boards & Dimes', ladder: [4, 6, 8, 10, 12, 14, 16], value: (s) => s.reb, eligible: isRotation },
  { id: 'ast', label: 'Assists', group: 'Boards & Dimes', ladder: [2, 4, 6, 8, 10, 12, 14], value: (s) => s.ast, eligible: isRotation },
  { id: 'tpm', label: '3PM', group: 'Scoring', ladder: [1, 2, 3, 4, 5, 6], value: (s) => s.tpm, eligible: isRotation },
  { id: 'pra', label: 'Pts+Reb+Ast', group: 'Combos', ladder: [15, 20, 25, 30, 35, 40, 45, 50, 55], value: (s) => (s.pts ?? 0) + (s.reb ?? 0) + (s.ast ?? 0), eligible: isRotation },
  { id: 'pr', label: 'Pts+Reb', group: 'Combos', ladder: [10, 15, 20, 25, 30, 35, 40, 45], value: (s) => (s.pts ?? 0) + (s.reb ?? 0), eligible: isRotation },
  { id: 'pa', label: 'Pts+Ast', group: 'Combos', ladder: [10, 15, 20, 25, 30, 35, 40, 45], value: (s) => (s.pts ?? 0) + (s.ast ?? 0), eligible: isRotation },
  { id: 'ra', label: 'Reb+Ast', group: 'Combos', ladder: [6, 8, 10, 12, 15, 18], value: (s) => (s.reb ?? 0) + (s.ast ?? 0), eligible: isRotation },
  { id: 'stl', label: 'Steals', group: 'Defense', ladder: [1, 2], value: (s) => s.stl, eligible: isRotation },
  { id: 'blk', label: 'Blocks', group: 'Defense', ladder: [1, 2], value: (s) => s.blk, eligible: isRotation },
];

// Players tab: game-log columns. A group shows when the player does that job (show(games)).
const FOOTBALL_LOG = [
  { label: 'Passing', show: (g) => avgOf(g, 'att') >= 3, cols: [
    { label: 'C/ATT', value: (s) => s.cmp, text: (s) => `${s.cmp ?? 0}/${s.att ?? 0}` },
    { label: 'YDS', value: (s) => s.passYds },
    { label: 'TD', value: (s) => s.passTd },
    { label: 'INT', value: (s) => s.int },
  ] },
  { label: 'Rushing', show: (g) => avgOf(g, 'rushAtt') >= 1, cols: [
    { label: 'CAR', value: (s) => s.rushAtt },
    { label: 'YDS', value: (s) => s.rushYds },
    { label: 'TD', value: (s) => s.rushTd },
  ] },
  { label: 'Receiving', show: (g) => avgOf(g, 'rec') >= 0.5 || avgOf(g, 'tgt') >= 1, cols: [
    { label: 'REC', value: (s) => s.rec },
    { label: 'TGT', value: (s) => s.tgt },
    { label: 'YDS', value: (s) => s.recYds },
    { label: 'TD', value: (s) => s.recTd },
  ] },
];
const BASKETBALL_LOG = [
  { label: '', show: () => true, cols: [
    { label: 'MIN', value: (s) => s.min },
    { label: 'PTS', value: (s) => s.pts },
    { label: 'REB', value: (s) => s.reb },
    { label: 'AST', value: (s) => s.ast },
    { label: '3PM', value: (s) => s.tpm },
    { label: 'STL', value: (s) => s.stl },
    { label: 'BLK', value: (s) => s.blk },
    { label: 'PRA', value: (s) => (s.pts ?? 0) + (s.reb ?? 0) + (s.ast ?? 0) },
  ] },
];

// Discovery: which leaderboard pulls give us the players worth tracking.
// Each request is tried; failures are tolerated (scoreboard leaders are a second source).
const FOOTBALL_DISCOVERY = (limits) => [
  { category: 'offense:passing', sort: 'passing.passingYards:desc', limit: limits.passing },
  { category: 'offense:rushing', sort: 'rushing.rushingYards:desc', limit: limits.rushing },
  { category: 'offense:receiving', sort: 'receiving.receivingYards:desc', limit: limits.receiving },
];

// Matchups tab: team defense from box scores ("allowed" = what opponents' offenses put up).
const FOOTBALL_TEAM_STATS = [
  { id: 'pts', label: 'Points allowed', from: 'score' },
  { id: 'yds', label: 'Yards allowed', names: ['totalYards'] },
  { id: 'passYds', label: 'Pass yds allowed', names: ['netPassingYards'] },
  { id: 'rushYds', label: 'Rush yds allowed', names: ['rushingYards'] },
  { id: 'sacks', label: 'Sacks', names: ['sacksYardsLost'], higherIsTougher: true },
  { id: 'takeaways', label: 'Takeaways', names: ['turnovers'], higherIsTougher: true },
];
const BASKETBALL_TEAM_STATS = [
  { id: 'pts', label: 'Points allowed', from: 'score' },
  { id: 'reb', label: 'Rebounds allowed', names: ['totalRebounds', 'rebounds'] },
  { id: 'ast', label: 'Assists allowed', names: ['assists'] },
  { id: 'tpm', label: '3PM allowed', names: ['threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'threePointFieldGoalsMade'] },
  { id: 'fgPct', label: 'Opp FG%', names: ['fieldGoalPct'] },
];
// How each position group has done against a defense, by our prop markets.
const FOOTBALL_DVP = { QBs: ['passYds', 'rushYds'], RBs: ['rushYds', 'rec'], WRs: ['recYds', 'rec'], TEs: ['recYds', 'rec'] };
// Basketball splits into the five positions, every stat for each.
const BB_DVP_STATS = ['pts', 'reb', 'ast', 'tpm', 'pra'];
const BASKETBALL_DVP = { PG: BB_DVP_STATS, SG: BB_DVP_STATS, SF: BB_DVP_STATS, PF: BB_DVP_STATS, C: BB_DVP_STATS };
const BASKETBALL_DVP_GROUPS = ['PG', 'SG', 'SF', 'PF', 'C'].map((x) => ({ label: x, match: [x] }));

// ESPN's leaderboards often say only G / F. The build swaps in the roster's position when it
// is specific; otherwise the player's role decides: a guard averaging 4.5+ assists is a PG,
// a forward averaging 7+ rebounds a PF.
export function basketballPosition(p) {
  const pos = String(p.pos || '').toUpperCase();
  if (['PG', 'SG', 'SF', 'PF', 'C'].includes(pos)) return pos;
  const recent = (p.games || []).slice(0, 10);
  if (pos === 'G') return avgOf(recent, 'ast') >= 4.5 ? 'PG' : 'SG';
  if (pos === 'F') return avgOf(recent, 'reb') >= 7 ? 'PF' : 'SF';
  if (pos === 'GF' || pos === 'G-F') return 'SF';
  if (pos === 'FC' || pos === 'F-C') return 'PF';
  if (pos === 'CF' || pos === 'C-F') return 'C';
  return null;
}

export const LEAGUES = {
  nfl: {
    key: 'nfl',
    label: 'NFL',
    sport: 'football',
    league: 'nfl',
    // Kalshi player-prop series for Best Bets -> our market id.
    kalshiSeries: {
      KXNFLPASSYDS: 'passYds', KXNFLPASSTDS: 'passTd', KXNFLPASSCOMP: 'cmp', KXNFLPASSINT: 'int',
      KXNFLRSHYDS: 'rushYds', KXNFLRSHATT: 'rushAtt', KXNFLRECYDS: 'recYds', KXNFLREC: 'rec',
      KXNFLRRYDS: 'rushRecYds', KXNFLTD: 'anyTd',
    },
    // Ladders / escalators: pay a slice of $1 by the final stat (payout rules in ladders.js).
    kalshiScalar: {
      KXNFLLADDERRECYDS: { kind: 'ladder', stat: 'recYds' },
      KXNFLLADDERRSHYDS: { kind: 'ladder', stat: 'rushYds' },
      KXNFLLADDERREC: { kind: 'ladder', stat: 'rec' },
      KXNFLESCALATORRECYDS: { kind: 'escalator', stat: 'recYds' },
      KXNFLESCALATORRSHYDS: { kind: 'escalator', stat: 'rushYds' },
      KXNFLESCALATORREC: { kind: 'escalator', stat: 'rec' },
    },
    teamStats: FOOTBALL_TEAM_STATS,
    teamGames: 17,
    dvp: FOOTBALL_DVP,
    roster: true, // Players tab can search every rostered player
    kind: 'football',
    stats: FOOTBALL_STATS,
    markets: FOOTBALL_MARKETS,
    log: FOOTBALL_LOG,
    discovery: FOOTBALL_DISCOVERY({ passing: 34, rushing: 60, receiving: 90 }),
    scoreboard: { params: {} },
    positionGroups: [
      { label: 'QBs', match: ['QB'] },
      { label: 'RBs', match: ['RB', 'FB'] },
      { label: 'WRs', match: ['WR'] },
      { label: 'TEs', match: ['TE'] },
    ],
  },
  cfb: {
    key: 'cfb',
    label: 'CFB',
    sport: 'football',
    league: 'college-football',
    kind: 'football',
    stats: FOOTBALL_STATS,
    markets: FOOTBALL_MARKETS,
    log: FOOTBALL_LOG,
    discovery: FOOTBALL_DISCOVERY({ passing: 60, rushing: 80, receiving: 100 }).map((d) => ({ ...d, groups: 80 })),
    scoreboard: { params: { groups: 80, limit: 400 } },
    positionGroups: [
      { label: 'QBs', match: ['QB'] },
      { label: 'RBs', match: ['RB', 'FB'] },
      { label: 'WRs', match: ['WR'] },
      { label: 'TEs', match: ['TE'] },
    ],
  },
  nba: {
    key: 'nba',
    label: 'NBA',
    sport: 'basketball',
    league: 'nba',
    kalshiSeries: {
      KXNBAPTS: 'pts', KXNBAREB: 'reb', KXNBAAST: 'ast', KXNBA3PT: 'tpm', KXNBASTL: 'stl',
      KXNBABLK: 'blk', KXNBAPRA: 'pra', KXNBAPR: 'pr', KXNBAPA: 'pa', KXNBARA: 'ra',
    },
    teamStats: BASKETBALL_TEAM_STATS,
    teamGames: 10,
    dvp: BASKETBALL_DVP,
    dvpGroups: BASKETBALL_DVP_GROUPS,
    dvpPosition: basketballPosition,
    dvpGames: 10, // positions vs defense: each defense's last 10 games, across seasons
    roster: true,
    seasonEnd: '04-13', // last regular-season day, used before the new season has games
    seasonEndYearOffset: -1,
    kind: 'basketball',
    stats: BASKETBALL_STATS,
    markets: BASKETBALL_MARKETS,
    log: BASKETBALL_LOG,
    discovery: [
      { sort: 'offensive.avgPoints:desc', limit: 150 },
      { sort: 'general.avgRebounds:desc', limit: 50 },
      { sort: 'offensive.avgAssists:desc', limit: 50 },
    ],
    scoreboard: { days: 3, params: {} },
    positionGroups: [
      { label: 'Guards', match: ['PG', 'SG', 'G'] },
      { label: 'Forwards', match: ['SF', 'PF', 'F', 'GF', 'FC'] },
      { label: 'Centers', match: ['C'] },
    ],
  },
  wnba: {
    key: 'wnba',
    label: 'WNBA',
    sport: 'basketball',
    league: 'wnba',
    // WNBA series names follow Kalshi's NBA pattern; unlisted ones are skipped quietly.
    kalshiSeries: { KXWNBAPTS: 'pts', KXWNBAREB: 'reb', KXWNBAAST: 'ast', KXWNBA3PT: 'tpm' },
    teamStats: BASKETBALL_TEAM_STATS,
    teamGames: 10,
    dvp: BASKETBALL_DVP,
    dvpGroups: BASKETBALL_DVP_GROUPS,
    dvpPosition: basketballPosition,
    dvpGames: 10, // positions vs defense: each defense's last 10 games, across seasons
    roster: true,
    seasonEnd: '09-12',
    seasonEndYearOffset: 0,
    kind: 'basketball',
    stats: BASKETBALL_STATS,
    markets: BASKETBALL_MARKETS,
    log: BASKETBALL_LOG,
    discovery: [
      { sort: 'offensive.avgPoints:desc', limit: 80 },
      { sort: 'general.avgRebounds:desc', limit: 30 },
      { sort: 'offensive.avgAssists:desc', limit: 30 },
    ],
    scoreboard: { days: 3, params: {} },
    positionGroups: [
      { label: 'Guards', match: ['PG', 'SG', 'G'] },
      { label: 'Forwards', match: ['SF', 'PF', 'F', 'GF', 'FC'] },
      { label: 'Centers', match: ['C'] },
    ],
  },
};

export const LEAGUE_KEYS = Object.keys(LEAGUES);
