# Prop Streaks

A cheatsheet-style website showing how often NFL, college football, NBA and WNBA players hit their player props, ranked so the most consistent hitters come first.

- **Top hitters**: every player/prop ranked by hit rate, then sample size, then current streak. Tap a row to see game-by-game bars and to test any line ("hit 58+ rush yds in 9/10").
- **Best bets** (NFL, NBA, WNBA): every player prop listed on **Kalshi**, compared with how often the player has cleared that exact line. The **edge** is the hit rate minus the market's price, ranked from best to worst. College football isn't included because Kalshi doesn't list CFB player props. For the NFL, a **Ladders & escalators** switch checks Kalshi's sliding-scale contracts. Ladders pay a fixed slice of $1 per yard or catch (0.25¢ a yard up to 400, 5¢ a catch up to 20). Escalators pay (yards ÷ 200)³ in 10-yard steps, or (catches ÷ 14)³. Each contract is valued at what it would have paid, on average, over the player's games in the sample. That value is compared with buying YES at the ask or NO at 1 − bid, after the fee. For ladders the page also shows the stat the price implies (price ÷ per-unit pay) next to the player's average and median.
- **Matchups** (NFL, NBA, WNBA): the upcoming games. For each team's defense it shows:
  - Season averages and league ranks for points, yards, passing and rushing yards allowed, sacks and takeaways (basketball: points, rebounds, assists, 3PM allowed, opponent FG%).
  - How each position group has done against that defense: their average, how many beat their usual number (each player's median), and by how much.
  - Basketball splits this into the five positions (PG, SG, SF, PF, C), with points, rebounds, assists, 3PM and PRA for each. ESPN's leaderboards usually list only G / F, so the build takes the position from the team roster when it's specific. Otherwise a guard averaging 4.5+ assists counts as a PG and a forward averaging 7+ rebounds as a PF. Tap a position to see every game behind it.
  - The opposing players to watch.

  Ranks: #1 is the toughest defense, and green marks a soft spot for overs.

  Each game also shows ESPN's injury report: OUT, DOUBT, Q and DTD tags, whether the injury is new this week, and an estimated return date when ESPN lists one. Football games list the offense's injuries and the other team's defensive injuries. BACK marks a tracked player who missed recent games but is no longer on the report. Injured tracked players show on the collapsed game card.
- **Players**: search any player in the league (NFL, NBA and WNBA search every rostered player; college football searches the tracked stat leaders). Each player shows their averages and medians, a bar chart for any prop with an adjustable line, and their full game log for the last 5/10/15/20 games or this season. "Full game log →" under a Top hitters row opens the same page.
- **Cheatsheet**: the same results grouped by position in the "Stroud 200+ Pass Yds 4/5 (Missed last)" format, with a Copy button.
- Filters: sample (last 5/10/15/20 or this season), minimum hit rate, prop type, search, "Playing next" (teams on the upcoming slate), and "Best prop per player".

For each player and prop, the site tests sportsbook-style alt lines (for example 175/200/225/250… pass yards, or 10/15/20/25… points) and shows the **highest line that still clears your hit rate**.

Sportsbooks set the main line near a player's median, so lines far below it aren't offered, or pay almost nothing. The **Lines** setting controls how far below the median (from the last 20 games) a line can sit:

- **Near main line**: at least 90% of the median.
- **Alt lines** (default): at least 75%.
- **Deep alts**: at least 60%.

Yes/no bets like Anytime TD are always shown.

## Data

Stats come from ESPN's free public JSON endpoints, which need no API key:

- `site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/statistics/byathlete`: leaderboards used to pick which players to track.
- `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard`: the upcoming games plus each team's stat leaders.
- `site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`: game-by-game stats. The previous season is pulled in when the current one has too few games.

Preseason games are ignored.

Best Bets prices come from Kalshi's public API, which needs no key: `api.elections.kalshi.com/trade-api/v2/markets?series_ticker=…`, using the per-game player series such as `KXNFLPASSYDS` and `KXNBAPTS` (the full list is in `js/config.js`). Each rung reads "Player: 250+", and the price is the YES ask, plus Kalshi's taker fee (0.07 × P × (1 − P)).

The Players search list comes from `.../teams` and `.../teams/{id}/roster` (from `data/<league>-roster.json`, up to a week old, else live). A picked player's game log is pulled live in full (up to 100 games, so a whole NBA season fits), falling back to the stored games.

Injuries come from `site.web.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries` (falling back to `site.api.espn.com`), pulled live when the tab opens and every 15 minutes after that, or from `data/<league>-injuries.json`.

Matchups team defense comes from `site.api.espn.com/.../teams/{id}/schedule` and `.../summary?event={id}` box scores. "Allowed" means what opposing offenses put up. When the season has barely started (under 3 games), last season is used. The position-vs-defense numbers are computed in the browser from the tracked players' game logs.

Each data build also prints a plain-text Matchups report to the GitHub Actions log (the "Matchups NFL/NBA/WNBA" groups in the "Pull game logs from ESPN" step). It has the same numbers as the Matchups tab for every upcoming game, plus each tracked player's usual number and last 10 games, so picks can be checked against the site's data.

The hit rate is nudged toward 50% with (hits + 1) / (games + 2), so a 5-for-5 sample doesn't look like a sure thing. The page pulls prices live when it can and otherwise falls back to the `data/<league>-odds.json` file built by the workflow. The endpoints are undocumented, so ESPN can change them without notice.

## Running it

```bash
npm run build:data        # writes data/nfl.json, cfb.json, nba.json, wnba.json (needs internet)
npm run serve             # http://localhost:8080
npm test
```

If `data/<league>.json` is missing or older than 36 hours, the page pulls the game logs live from ESPN in the browser instead. That can take a little while and is cached for 3 hours.

## Hosting (GitHub Pages)

Live at **https://jmwilliams4430-ctrl.github.io/Betting-App/**.

`.github/workflows/pages.yml` runs the tests, rebuilds the data every 4 hours and deploys the site. If you ever need to set it up again:

1. Make sure the code is on the default branch.
2. Go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
3. Go to **Actions → "Update stats & deploy site" → Run workflow** for the first deploy.

Prop lines and markets are defined in `js/config.js`.
