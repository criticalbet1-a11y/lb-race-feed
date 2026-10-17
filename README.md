# lb-race-feed

Public, read-only snapshot of public weekly/monthly casino race leaderboards
(FrogBet, Jack, DuckDice, Tower), refreshed by GitHub Actions (one looping run scrapes every 10 min and re-dispatches itself every ~6 h; hourly cron = watchdog).

Output on the `data` branch: `races.json` (player names masked, text only, no links)
and `state.json` (budget counters + cached Tower contest hash). No secrets.

| source   | strategy                                         | target cadence |
|----------|--------------------------------------------------|----------------|
| Jack     | direct                                           | every run      |
| DuckDice | direct, headless Chromium fallback               | every run      |
| Tower    | Firecrawl (DE) / Scrape.do (DE), budget-paced    | contest ~25 min, weekly tournament ~4 h |
| FrogBet  | direct, Microlink (≤20/day), then paid proxy     | ~72 min        |

Paid proxies: each capped at 950 calls per calendar month, spread evenly per day
(paced through the day). Firecrawl also stops when its reported remaining credits < 30.
