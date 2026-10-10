# Prop Streaks

A cheatsheet-style website showing how often NFL, college football, NBA and WNBA players hit their player props, ranked so the most consistent hitters come first.

- **Top hitters**: every player/prop ranked by hit rate, then sample size, then current streak. Tap a row to see game-by-game bars and to test any line ("hit 58+ rush yds in 9/10").
- **Cheatsheet**: the same results grouped by position in the "Stroud 200+ Pass Yds 4/5 (Missed last)" format, with a Copy button.
- Filters: sample (last 5/10/15/20 or this season), minimum hit rate, prop type, search, "Playing next" (teams on the upcoming slate), and "Best prop per player".

For each player and prop, the site tests a ladder of alt lines (for example 150/175/200/225… pass yards) and shows the **highest line that still clears your hit rate**.

## Data

Stats come from ESPN's free public JSON endpoints, which need no API key:

- `site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/statistics/byathlete`: leaderboards used to pick which players to track.
- `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard`: the upcoming games plus each team's stat leaders.
- `site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`: game-by-game stats. The previous season is pulled in when the current one has too few games.

Preseason games are ignored. The endpoints are undocumented, so ESPN can change them without notice.

## Running it

```bash
npm run build:data        # writes data/nfl.json, cfb.json, nba.json, wnba.json (needs internet)
npm run serve             # http://localhost:8080
npm test
```

If `data/<league>.json` is missing or older than 36 hours, the page pulls the game logs live from ESPN in the browser instead. That can take a little while and is cached for 3 hours.

## Hosting (GitHub Pages)

`.github/workflows/pages.yml` runs the tests, rebuilds the data every 4 hours and deploys the site. To turn it on:

1. Make sure the code is on the default branch.
2. Go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
3. Go to **Actions → "Update stats & deploy site" → Run workflow** for the first deploy.

Prop lines and markets are defined in `js/config.js`.
