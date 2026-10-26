# lb-race-feed

Public, read-only snapshot of public weekly/monthly casino race leaderboards
(FrogBet, Jack, DuckDice, Tower), refreshed by GitHub Actions (one looping run scrapes every 10 min and re-dispatches itself every ~6 h; hourly cron = watchdog).

Sports FreeBet boards (including Jack `/tournaments/sport/…`) are not part of this feed.

Output on the `data` branch:

- `races.json` — live races plus frozen finals. Player names masked, text only, no links.
- `state.json` — budget counters, the cached Tower contest hash, and `jack.paid_at` (last paid Jack attempt). No secrets.

## How the site should read `races.json`

`updated_at` is when this file was written. Older snapshots have no `finished` key; treat that as `[]`.

`health` is one object per casino and describes the **live** fetch only.

| field | meaning |
| --- | --- |
| `status` | `ok`, `stale` (last fetch failed, previous boards still listed), or `error` (failed and nothing live left). |
| `races` | How many rows from this casino are in `races` right now. |
| `via` | Transport that produced the boards still on display: `direct`, `browser`, `microlink`, `scrapedo`, `firecrawl`, or a `+` combination. Kept across a failed fetch. |
| `fetched_at` | Last successful fetch. Stays put while `status` is `stale`. |
| `expected_interval_s` | Target cadence for that casino. Tower's health value is the contest cadence; each race also has its own `expected_interval_s`. Jack stays at 600s when direct or the browser served the board, and 12 hours when a paid proxy did. |
| `error` | Latest failure, when `status` is not `ok`. |
| `note` | `not due` when the paid fetch was skipped on cadence. `weekly tournament kept` when Tower refreshed the monthly contest and left the weekly board at its older `snapshot_at`. |

`races` is **only races still running**. Live tables should render this array and nothing else.

`finished` is frozen finals for races this feed was already tracking. Same shape as a live race, plus `finished_at`.

| field | meaning |
| --- | --- |
| `finished_at` | When this feed archived the row (ISO). Not the casino's end time. |
| `ends_at` | When the race ended. |
| `snapshot_at` | When that leaderboard was captured — the last good scrape while the race was live. |
| `leaderboard` | Final board. Never updated after the row is archived. |

Reading `finished`:

- Results / history reads `finished`. Do not merge it into the live table, and do not expect those rows to change.
- A period's identity is `source_id` + `id` + `ends_at`, not `id` alone. The next week reuses `jack-western-wager`, `frogbet-weekly-wager-race`, `tower-weekly-tournament`, and so on, with a new `ends_at`. The previous period stays in `finished`; the new one appears in `races`.
- Newest `ends_at` first, capped at 30. Older finals are dropped.
- A row moves from `races` to `finished` when its `ends_at` has passed, or when the casino replaces it with the next non-overlapping period. A corrected window on a race that is still running (same id, overlapping dates) updates the live row and does not create a finished entry.
- The archived board is the last good snapshot. Ended races are not scraped again.
- Sports boards are never inserted into `races` or `finished`.

Player names are masked. There are no partner URLs. `source` is a short text note.

## Sources

| source   | strategy                                                      | target cadence |
|----------|---------------------------------------------------------------|----------------|
| Jack     | direct, then headless Chromium, then Scrape.do (Firecrawl only if Scrape.do fails) | every run; paid at most every 12 h |
| DuckDice | direct, headless Chromium fallback                            | every run |
| Tower    | Firecrawl (DE) / Scrape.do (DE), budget-paced                 | contest ~25 min, weekly tournament ~4 h |
| FrogBet  | direct, Microlink (≤20/day), then paid proxy                  | ~72 min |

Jack tries direct, then headless Chromium, on every run. A paid proxy runs only after both fail with a block or transport error, and at most once every 12 hours (a failed paid attempt backs off the same way, so a 10-minute loop does not retry it). Scrape.do is first whenever it has a full refresh left, even if Firecrawl has more allowance. Firecrawl is only the rest of that same refresh, and only when it too can cover every call.

A successful Jack refresh is 3 calls: the active-board list, plus one tournament payload per casino board. The sports board is not requested. While direct and the browser stay blocked and Scrape.do returns the JSON, that is 3 Scrape.do calls every 12 hours (6/day, about 180/month) and 0 Firecrawl calls. If Scrape.do fails, the rest of that refresh uses Firecrawl (up to 3 calls) and the next paid attempt waits 12 hours. A challenge page Scrape.do still bills costs one Scrape.do credit on the first URL, then the other URLs are not sent there again. The 12-hour gap is the spare inside the shared day pace; a faster paid loop crowds Tower. While direct or the browser works, Jack still refreshes every run and spends nothing.

Jack's window is the board's `CurrentStartDate` / `CurrentEndDate`. A one-shot week (Halloween, through 31 Oct 2026) is not cut to the next Wednesday. A multi-week campaign (Western Wager) still follows that current week. Ids stay on the existing slugs (`jack-western-wager`, `jack-halloween-tournament`).

Paid proxies: each capped at 950 calls per calendar month, spread evenly per day
(paced through the day). Firecrawl also stops when its reported remaining credits < 30.
Jack spends those budgets only on the paid step above. `state.json` `jack.paid_at` is the last paid attempt; `jack.error` is the scrubbed reason replayed until the next one.

Tests: `node --experimental-strip-types --test src/*.test.ts`
