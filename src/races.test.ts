import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS } from "./races.ts";

const NOW = Date.parse("2026-10-25T17:20:00.000Z");

const boards = [
  {
    Id: 2266,
    LeaderBoardStatus: 1,
    TypeName: "Weekly",
    LeaderBoardDesigneTypeName: "tournament",
    LeaderBoardName: "WEEKLY TOURNAMENT",
    Title: "Weekly Casino Tournament",
    PrizeFund: "$40 000",
    StartDate: "2026-10-21T12:00:00",
    EndDate: "2026-11-18T12:00:00",
    CurrentStartDate: "2026-10-21T12:00:00",
    CurrentEndDate: "2026-10-28T12:00:00",
    Rule: '<p>"Western Wager" Weekly Tournament</p>',
  },
  {
    Id: 2279,
    LeaderBoardStatus: 1,
    TypeName: "Weekly",
    LeaderBoardDesigneTypeName: "tournament",
    LeaderBoardName: "HALLOWEEN_TOURNAMENT",
    Title: "Jack\u2019s Haunted Reels",
    PrizeFund: "$15 000",
    StartDate: "2026-10-24T00:00:00",
    EndDate: "2026-10-31T00:00:00",
    CurrentStartDate: "2026-10-24T00:00:00",
    CurrentEndDate: "2026-10-31T00:00:00",
    Rule: "<h3>Jack\u2019s Haunted Reels Halloween Tournament</h3>",
  },
  {
    Id: 1709,
    LeaderBoardStatus: 1,
    TypeName: "Weekly",
    LeaderBoardDesigneTypeName: "tournament",
    LeaderBoardName: "WEEKLY SPORTS",
    Title: "Weekly Sports Tournament",
    PrizeFund: "$20 000",
    StartDate: "2026-10-21T12:00:00",
    EndDate: "2026-10-28T12:00:00",
    CurrentStartDate: "2026-10-21T12:00:00",
    CurrentEndDate: "2026-10-28T12:00:00",
    Rule: "Weekly Sports Tournament, $20k FreeBets",
  },
];

test("jack keeps casino ids, uses the casino window, and skips sports", async () => {
  const jack = ADAPTERS.find((a) => a.id === "jack");
  assert.ok(jack);
  const calls: string[] = [];
  const races = await jack.run({
    now: NOW,
    async getJSON(url) {
      calls.push(url);
      if (url.includes("getActiveLeaderBoards")) return boards;
      const id = new URL(url).searchParams.get("leaderBoardId");
      assert.notEqual(id, "1709");
      if (id === "2266") {
        return { currentPrize: [{ place: 1, point: 5645982, userName: "A****l", amount: 2000, prize: "" }] };
      }
      return { currentPrize: [{ place: 1, point: 1194002.92, userName: "P****o", amount: 3500, prize: "" }] };
    },
  });

  assert.deepEqual(races.map((r) => r.id), ["jack-western-wager", "jack-halloween-tournament"]);
  const western = races[0];
  assert.equal(western.name, "Western Wager");
  assert.equal(western.started_at, "2026-10-21T12:00:00.000Z");
  assert.equal(western.ends_at, "2026-10-28T12:00:00.000Z");
  assert.match(western.source, /tournaments\/2266/);
  assert.match(western.source, /Resets Wednesdays 12:00 UTC/);
  assert.equal(western.leaderboard[0].player, "A****l");
  assert.equal(western.leaderboard[0].wagered, 5645982);

  const halloween = races[1];
  assert.equal(halloween.name, "Jack's Haunted Reels");
  assert.equal(halloween.id, "jack-halloween-tournament");
  assert.equal(halloween.started_at, "2026-10-24T00:00:00.000Z");
  assert.equal(halloween.ends_at, "2026-10-31T00:00:00.000Z");
  assert.equal(halloween.cadence, "weekly");
  assert.match(halloween.source, /tournaments\/2279/);
  assert.doesNotMatch(halloween.source, /Resets Wednesdays/);
  assert.match(halloween.source, /\$15,000/);
  assert.equal(halloween.leaderboard[0].player, "P****o");
  assert.equal(halloween.leaderboard[0].wagered, 1194003);

  assert.ok(calls.some((u) => u.includes("leaderBoardId=2266")));
  assert.ok(calls.some((u) => u.includes("leaderBoardId=2279")));
  assert.ok(!calls.some((u) => u.includes("1709") || u.includes("sport")));
  assert.ok(!races.some((r) => /sport/i.test(r.name) || r.source.includes("/sport/")));
});
