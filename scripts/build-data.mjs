// Pre-builds data/<league>.json from ESPN so the site loads instantly.
// Usage: node scripts/build-data.mjs [nfl cfb nba wnba]
import { mkdir, writeFile } from 'node:fs/promises';
import { LEAGUES, LEAGUE_KEYS } from '../js/config.js';
import { buildLeagueData } from '../js/espn.js';
import { fetchMarketQuotes } from '../js/odds.js';
import { buildTeamData } from '../js/teams.js';

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
    console.log(`  markets: Kalshi ${odds.venues.K ? by('K') : 'unavailable'}`);
    for (const line of odds.log.slice(0, 8)) console.log(`  ! ${line}`);
    await writeFile(new URL(`${key}-odds.json`, outDir), JSON.stringify(odds));
  }

  // Team defense for the Matchups tab.
  if (cfg.teamStats) {
    try {
      const teams = await buildTeamData(cfg, { concurrency: 8 });
      const played = Object.values(teams.teams).filter((t) => t.n).length;
      console.log(`  defense: ${played} teams with games (${teams.seasonNote})`);
      for (const line of teams.log.slice(0, 5)) console.log(`  ! ${line}`);
      if (played) await writeFile(new URL(`${key}-teams.json`, outDir), JSON.stringify(teams));
    } catch (err) {
      console.error(`  defense: failed (${err.message})`);
    }
  }
}
if (failures === keys.length) process.exitCode = 1;
