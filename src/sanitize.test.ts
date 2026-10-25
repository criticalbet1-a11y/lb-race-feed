import assert from "node:assert/strict";
import test from "node:test";
import { mergeFinished, periodKey, splitPrev } from "./archive.ts";
import { sanitizeRace } from "../scrape.mjs";

function live(over = {}) {
  return {
    id: "jack-western-wager",
    source_id: "jack",
    cadence: "weekly",
    casino: "Jack",
    casino_logo: null,
    name: "Western Wager",
    prize_pool: 9200,
    prize_extra: null,
    currency: "USD",
    score_unit: "points",
    points_per_dollar: 1,
    eligible_games: ["Slots", "Live casino"],
    source: "JACK public tournament leaderboard (jack.com/en/tournaments/2266). 1 point per $1 wagered.",
    started_at: "2026-10-21T12:00:00.000Z",
    ends_at: "2026-10-28T12:00:00.000Z",
    duration_seconds: 604800,
    snapshot_at: "2026-10-24T17:15:42.650Z",
    expected_interval_s: 600,
    leaderboard: [{ place: 1, player: "A****l", wagered: 5645982, prize: 2000, prize_extra: null }],
    ...over,
  };
}

test("sanitize keeps a masked live board and omits finished_at", () => {
  const out = sanitizeRace(live({ leaderboard: [{ place: 1, player: "<b>A****l</b>", wagered: 10, prize: 2000, prize_extra: null }] }));
  assert.ok(out);
  assert.equal(out.leaderboard[0].player, "A****l");
  assert.equal("finished_at" in out, false);
  assert.equal(out.casino_logo, null);
});

test("archiving a real board freezes it and a later copy does not replace it", () => {
  const prev = [live()];
  const now = Date.parse("2026-10-28T12:10:00.000Z");
  const split = splitPrev(prev, null, now, { fetched: () => false });
  const done = mergeFinished(split.archive, [], "2026-10-28T12:10:00.000Z", 30, (r) => sanitizeRace(r, { finished: true }));
  // mergeFinished sanitizes only newly archived rows; pass them as newlyArchived.
  const archived = mergeFinished([], split.archive, "2026-10-28T12:10:00.000Z", 30, (r) => sanitizeRace(r, { finished: true }));
  assert.equal(done.length, 0);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].finished_at, "2026-10-28T12:10:00.000Z");
  assert.equal(archived[0].leaderboard[0].player, "A****l");
  assert.equal(archived[0].leaderboard[0].wagered, 5645982);
  const again = mergeFinished(archived, [live({ leaderboard: [{ place: 1, player: "Z****z", wagered: 9, prize: 1, prize_extra: null }] })], "2026-11-01T00:00:00.000Z", 30, (r) => sanitizeRace(r, { finished: true }));
  assert.equal(again[0], archived[0]);
  assert.equal(again[0].leaderboard[0].player, "A****l");
  assert.equal(periodKey(again[0]), periodKey(archived[0]));
});

test("a still-running corrected halloween window is not a finished row", () => {
  const prev = [live({ id: "jack-halloween-tournament", name: "Halloween_tournament", ends_at: "2026-10-28T12:00:00.000Z", started_at: "2026-10-21T12:00:00.000Z" })];
  const fresh = [live({
    id: "jack-halloween-tournament",
    name: "Jack's Haunted Reels",
    started_at: "2026-10-24T00:00:00.000Z",
    ends_at: "2026-10-31T00:00:00.000Z",
    leaderboard: [{ place: 1, player: "P****o", wagered: 1194003, prize: 3500, prize_extra: null }],
  })];
  const split = splitPrev(prev, fresh, Date.parse("2026-10-25T17:26:00.000Z"), { fetched: () => true });
  assert.equal(split.archive.length, 0);
  const published = split.live.map((r) => sanitizeRace(r)).filter(Boolean);
  assert.equal(published.length, 1);
  assert.equal(published[0].ends_at, "2026-10-31T00:00:00.000Z");
  assert.equal(published[0].name, "Jack's Haunted Reels");
});
