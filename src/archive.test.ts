import assert from "node:assert/strict";
import test from "node:test";
import { FINISHED_CAP, isSuccessor, mergeFinished, periodKey, priorLive, splitPrev, type RaceLike } from "./archive.ts";

const NOW = Date.parse("2026-10-25T17:26:00.000Z");

function race(id: string, source_id: string, started_at: string, ends_at: string, player = "A****l"): RaceLike & { leaderboard: { player: string }[] } {
  return { id, source_id, started_at, ends_at, leaderboard: [{ player }] };
}

const keep = () => ({ fetched: () => true });

test("same period refreshes in place and does not archive", () => {
  const prev = [race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z", "u****s")];
  const fresh = [race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z", "A****l")];
  const split = splitPrev(prev, fresh, NOW, keep());
  assert.equal(split.archive.length, 0);
  assert.equal(split.live.length, 1);
  assert.equal(split.live[0].leaderboard?.[0] && (split.live[0].leaderboard[0] as { player: string }).player, "A****l");
});

test("overlapping correction replaces the live row and does not invent a final", () => {
  // Stored Halloween end was the next Wednesday. The casino window runs through 31 Oct.
  const prev = [race("jack-halloween-tournament", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z")];
  const fresh = [race("jack-halloween-tournament", "jack", "2026-10-24T00:00:00.000Z", "2026-10-31T00:00:00.000Z", "P****o")];
  assert.equal(isSuccessor(prev[0], fresh[0]), false);
  const split = splitPrev(prev, fresh, NOW, keep());
  assert.equal(split.archive.length, 0);
  assert.equal(split.live.length, 1);
  assert.equal(split.live[0].ends_at, "2026-10-31T00:00:00.000Z");
});

test("the four boards that are still running are not archived", () => {
  const prev = [
    race("frogbet-weekly-wager-race", "frogbet", "2026-10-21T00:00:00.000Z", "2026-10-28T00:00:00.000Z"),
    race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z"),
    race("jack-halloween-tournament", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z"),
    race("duckdice-monthly-contest", "duckdice", "2026-10-07T14:00:00.000Z", "2026-11-07T13:59:00.000Z"),
    race("tower-monthly-contest", "tower", "2026-10-01T00:00:00.000Z", "2026-10-31T23:50:00.000Z"),
    race("tower-weekly-tournament", "tower", "2026-10-23T15:00:00.000Z", "2026-10-30T15:00:00.000Z"),
  ];
  const fresh = [
    race("frogbet-weekly-wager-race", "frogbet", "2026-10-21T00:00:00.000Z", "2026-10-28T00:00:00.000Z"),
    race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z"),
    race("jack-halloween-tournament", "jack", "2026-10-24T00:00:00.000Z", "2026-10-31T00:00:00.000Z"),
    race("duckdice-monthly-contest", "duckdice", "2026-10-07T14:00:00.000Z", "2026-11-07T13:59:00.000Z"),
    race("tower-monthly-contest", "tower", "2026-10-01T00:00:00.000Z", "2026-10-31T23:50:00.000Z"),
    race("tower-weekly-tournament", "tower", "2026-10-23T15:00:00.000Z", "2026-10-30T15:00:00.000Z"),
  ];
  const split = splitPrev(prev, fresh, NOW, keep());
  assert.deepEqual(split.archive.map((r) => r.id), []);
  assert.equal(split.live.length, 6);
  assert.equal(split.live.find((r) => r.id === "tower-weekly-tournament")?.ends_at, "2026-10-30T15:00:00.000Z");
  assert.ok(!split.live.some((r) => r.id.includes("1709") || /sport/i.test(r.id)));
});

test("a new non-overlapping period archives the previous board once", () => {
  const prev = [race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z", "A****l")];
  const fresh = [race("jack-western-wager", "jack", "2026-10-28T12:00:00.000Z", "2026-11-04T12:00:00.000Z", "B****b")];
  const at = Date.parse("2026-10-28T12:00:30.000Z");
  assert.equal(isSuccessor(prev[0], fresh[0]), true);
  const split = splitPrev(prev, fresh, at, keep());
  assert.equal(split.archive.length, 1);
  assert.equal(split.archive[0].leaderboard?.[0] && (split.archive[0].leaderboard[0] as { player: string }).player, "A****l");
  assert.equal(split.live[0].ends_at, "2026-11-04T12:00:00.000Z");

  const finishedAt = "2026-10-28T12:05:00.000Z";
  const done = mergeFinished([], split.archive, finishedAt, FINISHED_CAP, (r) => r);
  const again = mergeFinished(done, [race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z", "CHANGED")], finishedAt, FINISHED_CAP, (r) => r);
  assert.equal(again.length, 1);
  assert.equal(again[0], done[0]);
  assert.equal((again[0].leaderboard?.[0] as { player: string }).player, "A****l");
  assert.equal(again[0].finished_at, finishedAt);
});

test("ends_at in the past archives on a failed fetch and stays frozen", () => {
  const prev = [race("frogbet-weekly-wager-race", "frogbet", "2026-10-14T00:00:00.000Z", "2026-10-21T00:00:00.000Z", "Old*****")];
  const split = splitPrev(prev, null, NOW, { fetched: () => false });
  assert.equal(split.live.length, 0);
  assert.equal(split.archive.length, 1);
  const done = mergeFinished([], split.archive, "2026-10-25T17:26:00.000Z", FINISHED_CAP, (r) => r);
  assert.equal(done[0].finished_at, "2026-10-25T17:26:00.000Z");
});

test("tower tournament not queried stays live; a missing ended one is archived; an early drop is not a final", () => {
  const weekly = race("tower-weekly-tournament", "tower", "2026-10-23T15:00:00.000Z", "2026-10-30T15:00:00.000Z");
  const kept = splitPrev([weekly], [], NOW, { fetched: () => false });
  assert.equal(kept.live.length, 1);
  assert.equal(kept.archive.length, 0);

  const ended = race("tower-weekly-tournament", "tower", "2026-10-16T15:00:00.000Z", "2026-10-23T15:00:00.000Z");
  const archived = splitPrev([ended], [], NOW, { fetched: () => true, dropIfMissing: () => true });
  assert.equal(archived.archive.length, 1);

  const early = splitPrev([weekly], [], NOW, { fetched: () => true, dropIfMissing: () => true });
  assert.equal(early.live.length, 0);
  assert.equal(early.archive.length, 0);
});

test("failed fetch keeps a still-running board", () => {
  const prev = [race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z")];
  const split = splitPrev(prev, null, NOW, { fetched: () => false });
  assert.equal(split.live.length, 1);
  assert.equal(split.archive.length, 0);
});

test("prior unfinished rows are tracked once, races win on the same period", () => {
  const live = race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z", "live");
  const hold = race("jack-western-wager", "jack", "2026-10-21T12:00:00.000Z", "2026-10-28T12:00:00.000Z", "hold");
  const extra = race("jack-halloween-tournament", "jack", "2026-10-24T00:00:00.000Z", "2026-10-31T00:00:00.000Z", "hold");
  const rows = priorLive([live], [hold, extra]);
  assert.deepEqual(rows.map((r) => periodKey(r)), [periodKey(live), periodKey(extra)]);
  assert.equal((rows[0].leaderboard?.[0] as { player: string }).player, "live");
});

test("finished cap keeps the newest ends_at and never rewrites a frozen board", () => {
  const prev = Array.from({ length: FINISHED_CAP }, (_, i) => {
    const day = String(i + 1).padStart(2, "0");
    return { ...race(`r-${i}`, "frogbet", `2026-09-${day}T00:00:00.000Z`, `2026-10-${day}T00:00:00.000Z`), finished_at: "2026-10-25T00:00:00.000Z" };
  });
  const newest = { ...race("r-new", "jack", "2026-10-24T00:00:00.000Z", "2026-10-31T00:00:00.000Z", "New*****"), finished_at: "" };
  const done = mergeFinished(prev, [newest], "2026-10-31T00:05:00.000Z", FINISHED_CAP, (r) => r);
  assert.equal(done.length, FINISHED_CAP);
  assert.equal(done[0].id, "r-new");
  assert.equal(done[0].finished_at, "2026-10-31T00:05:00.000Z");
  assert.ok(done.includes(prev[29]));
  assert.ok(!done.some((r) => r.id === "r-0"));
  const rewritten = mergeFinished(done, [{ ...newest, leaderboard: [{ player: "NOPE" }] }], "2026-11-01T00:00:00.000Z", FINISHED_CAP, (r) => r);
  assert.equal(rewritten[0], done[0]);
  assert.equal((rewritten[0].leaderboard?.[0] as { player: string }).player, "New*****");
});
