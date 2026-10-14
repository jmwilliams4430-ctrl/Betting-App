# Prop Streaks

A cheatsheet-style website showing how often NFL, college football, NBA and WNBA players hit their player props, ranked so the most consistent hitters come first.

- **Top hitters**: every player/prop ranked by hit rate, then sample size, then current streak. Tap a row to see game-by-game bars and to test any line ("hit 58+ rush yds in 9/10").
- **Best bets** (NFL, NBA, WNBA): every player prop listed on **Kalshi** or **Polymarket US**, compared with how often the player has cleared that exact line. The **edge** is the hit rate minus the market's price, ranked from best to worst. College football isn't included because neither site lists CFB player props.
- **Matchups** (NFL, NBA, WNBA): the upcoming games. For each team's defense it shows:
  - Season averages and league ranks for points, yards, passing and rushing yards allowed, sacks and takeaways (basketball: points, rebounds, assists, 3PM allowed, opponent FG%).
  - How each position group has done against that defense: their average, how many beat their usual number (each player's median), and by how much.
  - The opposing players to watch.

  Ranks: #1 is the toughest defense, and green marks a soft spot for overs.
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

Best Bets prices come from two public APIs that need no key:

- **Kalshi**: `api.elections.kalshi.com/trade-api/v2/markets?series_ticker=…`, using the per-game player series such as `KXNFLPASSYDS` and `KXNBAPTS` (the full list is in `js/config.js`). Each rung reads "Player: 250+", and the price is the YES ask, plus Kalshi's taker fee (0.07 × P × (1 − P)).
- **Polymarket US**: `gateway.polymarket.us/v1/events?tagSlug=nfl` and similar. This is the US app's own exchange, whose prices differ from the international polymarket.com book. Each player market has a `sportsMarketType` such as `football_player_passing_yards` and a line N meaning "N+". The price is the YES ask, plus Polymarket US's taker fee (0.0695 × P × (1 − P)).

Matchups team defense comes from `site.api.espn.com/.../teams/{id}/schedule` and `.../summary?event={id}` box scores. "Allowed" means what opposing offenses put up. When the season has barely started (under 3 games), last season is used. The position-vs-defense numbers are computed in the browser from the tracked players' game logs.

The hit rate is nudged toward 50% with (hits + 1) / (games + 2), so a 5-for-5 sample doesn't look like a sure thing. The page pulls prices live in the browser, and uses a `data/<league>-odds.json` file instead if one is hosted next to it. The endpoints are undocumented, so ESPN can change them without notice.

## Running it

```bash
npm run build:data        # writes data/nfl.json, cfb.json, nba.json, wnba.json (needs internet)
npm run serve             # http://localhost:8080
npm test
```

If `data/<league>.json` is missing or older than 36 hours, the page pulls the game logs live from ESPN in the browser instead. That can take a little while and is cached for 3 hours.

## Hosting

The site is plain static files, so any static host works. It's currently opened straight from GitHub through raw.githack.com. Each visitor's browser pulls the stats live from ESPN, Kalshi and Polymarket US, and caches them for a few hours.

`.github/workflows/test.yml` runs the tests on every push. To pre-build data instead, run `npm run build:data` and host the `data/` folder next to the page; the site uses those files when they're less than 36 hours old.
