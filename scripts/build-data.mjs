// Pre-builds data/<league>.json from ESPN so the site loads instantly.
// Usage: node scripts/build-data.mjs [nfl cfb nba wnba]
import { mkdir, writeFile } from 'node:fs/promises';
import { LEAGUES, LEAGUE_KEYS } from '../js/config.js';
import { buildLeagueData } from '../js/espn.js';
import { fetchMarketQuotes, nameKey } from '../js/odds.js';
import { scalarRows } from '../js/ladders.js';
import { buildTeamData } from '../js/teams.js';
import { fetchInjuries } from '../js/injuries.js';
import { fetchRoster } from '../js/roster.js';
import { matchupReport } from '../js/report.js';

const keys = process.argv.slice(2).length ? process.argv.slice(2) : LEAGUE_KEYS;
const outDir = new URL('../data/', import.meta.url);
await mkdir(outDir, { recursive: true });

let failures = 0;
for (const key of keys) {
  const cfg = LEAGUES[key];
  if (!cfg) {
    console.error(`Unknown league "${key}". Options: ${LEAGUE_KEYS.join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  const started = Date.now();
  const data = await buildLeagueData(cfg, { concurrency: 8, maxPlayers: key === 'cfb' ? 320 : 260 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const games = data.players.reduce((n, p) => n + p.games.length, 0);
  console.log(`${cfg.label}: ${data.players.length} players, ${games} games, ${Object.keys(data.schedule).length} schedule keys (${secs}s)`);
  for (const line of data.log.slice(0, 10)) console.log(`  ! ${line}`);
  if (!data.players.length) {
    failures++;
    console.error(`  ${cfg.label}: no players, keeping any previous file`);
    continue;
  }
  await writeFile(new URL(`${key}.json`, outDir), JSON.stringify(data));

  // Kalshi prices for Best Bets (the browser tops these up live when it can).
  if (cfg.kalshiSeries) {
    const odds = await fetchMarketQuotes(cfg, { pace: 400 });
    const by = (v) => odds.quotes.filter((q) => q.v === v).length;
    console.log(`  markets: Kalshi ${odds.venues.K ? by('K') : 'unavailable'}${cfg.kalshiScalar ? `, ladders/escalators ${odds.scalars.length}` : ''}`);
    for (const line of odds.log.slice(0, 8)) console.log(`  ! ${line}`);
    await writeFile(new URL(`${key}-odds.json`, outDir), JSON.stringify(odds));
    // Ladder / escalator values in the log, matching the site's check (last 10 games).
    if (odds.scalars.length) {
      console.log(`::group::Ladders ${cfg.label}`);
      const c = (x) => `${(x * 100).toFixed(1)}c`;
      for (const r of scalarRows(data.players, odds.scalars, nameKey, { window: 10, minGames: 5 })) {
        const read = r.implied !== null ? `implies ${r.implied.toFixed(1)}, ` : '';
        console.log(`${r.player.name} (${r.player.team}) ${r.q.stat} ${r.q.kind} ${r.q.date}: YES ${c(r.q.price)} / bid ${r.q.bid === null ? '-' : c(r.q.bid)}; ${read}L10 avg ${r.avg.toFixed(1)} med ${r.med} [${r.values.join(' ')}]; worth ${c(r.worth)}; best ${r.side} ${r.edge >= 0 ? '+' : ''}${c(r.edge)}`);
      }
      const unmatched = odds.scalars.filter((q) => !data.players.some((p) => nameKey(p.name) === nameKey(q.name)));
      if (unmatched.length) console.log(`not tracked: ${unmatched.map((q) => `${q.name} ${q.stat} ${q.kind} ${c(q.price)}`).join('; ')}`);
      console.log('::endgroup::');
    }
  }

  // Injury report for the Matchups tab (the browser pulls it live when it can).
  let injuries = null;
  if (cfg.teamStats) {
    injuries = await fetchInjuries(cfg);
    console.log(`  injuries: ${injuries.ok ? `${injuries.list.length} listed` : 'unavailable'}`);
    for (const line of injuries.log.slice(0, 3)) console.log(`  ! ${line}`);
    if (injuries.ok) await writeFile(new URL(`${key}-injuries.json`, outDir), JSON.stringify(injuries));
  }

  // Every rostered player, so the Players tab can search beyond the tracked ones.
  if (cfg.roster) {
    const roster = await fetchRoster(cfg);
    console.log(`  roster: ${roster.ok ? `${roster.players.length} players` : 'unavailable'}`);
    for (const line of roster.log.slice(0, 3)) console.log(`  ! ${line}`);
    if (roster.ok) await writeFile(new URL(`${key}-roster.json`, outDir), JSON.stringify(roster));
  }

  // Team defense for the Matchups tab.
  let teams = null;
  if (cfg.teamStats) {
    try {
      teams = await buildTeamData(cfg, { concurrency: 8 });
      const played = Object.values(teams.teams).filter((t) => t.n).length;
      console.log(`  defense: ${played} teams with games (${teams.seasonNote})`);
      for (const line of teams.log.slice(0, 5)) console.log(`  ! ${line}`);
      if (played) await writeFile(new URL(`${key}-teams.json`, outDir), JSON.stringify(teams));
    } catch (err) {
      console.error(`  defense: failed (${err.message})`);
    }
    // Every game's matchup numbers in the log, so picks can be checked against the site's data.
    console.log(`::group::Matchups ${cfg.label}`);
    try {
      for (const line of matchupReport(cfg, data, teams, injuries)) console.log(line);
    } catch (err) {
      console.error(`  matchups report failed (${err.message})`);
    }
    console.log('::endgroup::');
  }
}
if (failures === keys.length) process.exitCode = 1;
