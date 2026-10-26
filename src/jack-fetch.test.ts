import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS } from "./races.ts";
import { JACK_PAID_CADENCE_S, JACK_PAID_CALLS, fetchJack, jackPaidChoice, sanitizeRace } from "../scrape.mjs";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();

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

function payload(url) {
  if (String(url).includes("getActiveLeaderBoards")) return boards;
  const id = new URL(url).searchParams.get("leaderBoardId");
  if (id === "1709") throw new Error("sports board was requested");
  if (id === "2266") return { currentPrize: [{ place: 1, point: 5650042, userName: "A****l", amount: 2000, prize: "" }] };
  return { currentPrize: [{ place: 1, point: 1194002.92, userName: "P****o", amount: 3500, prize: "" }] };
}

function harness(over = {}) {
  const events = [];
  const opts = {
    now: NOW,
    lastOk: null,
    paidAt: null,
    lastProxyError: null,
    allowances: { scrapedo: 9, firecrawl: 40, firecrawl2: 0 },
    async direct() {
      events.push("direct");
      throw new Error("blocked (HTTP 403 challenge)");
    },
    async browser() {
      events.push("browser");
      throw new Error("browser HTTP 403");
    },
    async scrapedo(url) {
      events.push("scrapedo");
      return payload(url);
    },
    async firecrawl(url, provider) {
      events.push(provider);
      return payload(url);
    },
    onPaidAttempt() { events.push("paid-attempt"); },
    onPaidFailure(message) { events.push(`paid-fail:${message}`); },
    onPaidSuccess() { events.push("paid-ok"); },
    async run(getJSON) {
      const jack = ADAPTERS.find((a) => a.id === "jack");
      return jack.run({ now: NOW, getJSON });
    },
    ...over,
  };
  return { opts, events };
}

test("jack paid cadence is 12h and one refresh is 3 calls", () => {
  assert.equal(JACK_PAID_CADENCE_S, 12 * 3600);
  assert.equal(JACK_PAID_CALLS, 3);
  assert.equal(jackPaidChoice(NOW, { lastOk: ago(11 * 3600), allowances: { scrapedo: 9, firecrawl: 9 } }).kind, "skip");
  assert.equal(jackPaidChoice(NOW, { lastOk: ago(JACK_PAID_CADENCE_S), allowances: { scrapedo: 9 } }).kind, "scrapedo");
  assert.equal(jackPaidChoice(NOW, { paidAt: ago(60), lastProxyError: "scrapedo HTTP 403", allowances: { scrapedo: 9 } }).kind, "backoff");
  // Scrape.do wins even when Firecrawl has more room. Firecrawl only when Scrape.do cannot cover 3.
  assert.equal(jackPaidChoice(NOW, { allowances: { scrapedo: 3, firecrawl: 40 } }).kind, "scrapedo");
  assert.equal(jackPaidChoice(NOW, { allowances: { scrapedo: 2, firecrawl: 40 } }).kind, "firecrawl");
  assert.equal(jackPaidChoice(NOW, { allowances: { scrapedo: 2, firecrawl: 2, firecrawl2: 2 } }).kind, "exhausted");
  assert.equal(jackPaidChoice(NOW, { allowances: { scrapedo: 0, firecrawl: 0, firecrawl2: 3 } }).kind, "firecrawl");
});

test("direct success does not touch the browser or a proxy", async () => {
  const { opts, events } = harness();
  opts.direct = async () => {
    events.push("direct");
    return { ok: true };
  };
  opts.run = async (getJSON) => {
    await getJSON("https://jack.com/api/leaderBoard/getActiveLeaderBoards?languageId=1", "https://jack.com/en/tournaments");
    return [{ id: "jack-western-wager" }];
  };
  const res = await fetchJack(opts);
  assert.equal(res.via, "direct");
  assert.equal(res.expected_interval_s, 600);
  assert.deepEqual(events, ["direct"]);
});

test("a non-transport direct error does not fall through", async () => {
  const { opts, events } = harness();
  opts.direct = async () => {
    events.push("direct");
    throw new Error("unexpected shape");
  };
  await assert.rejects(fetchJack(opts), /unexpected shape/);
  assert.deepEqual(events, ["direct"]);
});

test("browser success stops before any paid call", async () => {
  const { opts, events } = harness();
  opts.browser = async () => {
    events.push("browser");
    return { async get(url) { return payload(url); }, async close() {} };
  };
  const res = await fetchJack(opts);
  assert.equal(res.via, "browser");
  assert.equal(res.expected_interval_s, 600);
  assert.equal(events.includes("scrapedo"), false);
  assert.equal(events.includes("firecrawl"), false);
  assert.equal(events.includes("paid-attempt"), false);
});

test("blocked direct and browser use scrapedo, not firecrawl, and keep casino windows", async () => {
  const { opts, events } = harness();
  const res = await fetchJack(opts);
  assert.equal(res.via, "scrapedo");
  assert.equal(res.expected_interval_s, JACK_PAID_CADENCE_S);
  assert.deepEqual(events.filter((e) => e === "scrapedo").length, 3);
  assert.equal(events.includes("firecrawl"), false);
  assert.equal(events.includes("paid-attempt"), true);
  assert.equal(events.includes("paid-ok"), true);
  assert.equal(events.some((e) => e.startsWith("paid-fail")), false);
  assert.deepEqual(events.slice(0, 3), ["direct", "browser", "paid-attempt"]);

  assert.deepEqual(res.races.map((r) => r.id), ["jack-western-wager", "jack-halloween-tournament"]);
  const western = res.races[0];
  assert.equal(western.name, "Western Wager");
  assert.equal(western.started_at, "2026-10-21T12:00:00.000Z");
  assert.equal(western.ends_at, "2026-10-28T12:00:00.000Z");
  assert.match(western.source, /tournaments\/2266/);
  assert.equal(western.leaderboard[0].player, "A****l");
  const halloween = res.races[1];
  assert.equal(halloween.name, "Jack's Haunted Reels");
  assert.equal(halloween.started_at, "2026-10-24T00:00:00.000Z");
  assert.equal(halloween.ends_at, "2026-10-31T00:00:00.000Z");
  assert.match(halloween.source, /tournaments\/2279/);
  assert.doesNotMatch(halloween.source, /Resets Wednesdays/);
  assert.equal(halloween.leaderboard[0].player, "P****o");
  assert.equal(res.races.some((r) => /sport/i.test(r.name) || r.source.includes("/sport/")), false);

  const published = res.races.map((r) => sanitizeRace({ ...r, expected_interval_s: res.expected_interval_s }));
  assert.equal(published.length, 2);
  assert.equal(published[0].id, "jack-western-wager");
  assert.equal(published[0].expected_interval_s, JACK_PAID_CADENCE_S);
  assert.equal(published[1].name, "Jack's Haunted Reels");
  assert.equal(published[1].ends_at, "2026-10-31T00:00:00.000Z");
  assert.equal(published.every((r) => !/sport/i.test(r.name)), true);
});

test("a scrapedo block falls through to firecrawl once, and does not keep calling scrapedo", async () => {
  const { opts, events } = harness();
  opts.scrapedo = async () => {
    events.push("scrapedo");
    throw new Error("blocked (challenge page)");
  };
  const res = await fetchJack(opts);
  assert.equal(res.via, "firecrawl");
  assert.deepEqual(events.filter((e) => e === "scrapedo"), ["scrapedo"]);
  assert.equal(events.filter((e) => e === "firecrawl").length, 3);
  assert.equal(res.races.map((r) => r.id).includes("jack-western-wager"), true);
  assert.equal(res.races.some((r) => /sport/i.test(r.id)), false);
});

test("scrapedo is not used when it cannot cover a full refresh", async () => {
  const { opts, events } = harness({ allowances: { scrapedo: 2, firecrawl: 9, firecrawl2: 0 } });
  const res = await fetchJack(opts);
  assert.equal(res.via, "firecrawl");
  assert.equal(events.includes("scrapedo"), false);
  assert.equal(events.filter((e) => e === "firecrawl").length, 3);
});

test("no full-refresh allowance spends nothing and is not a browser 403", async () => {
  const { opts, events } = harness({ allowances: { scrapedo: 2, firecrawl: 1, firecrawl2: 0 } });
  await assert.rejects(fetchJack(opts), /jack proxy budget exhausted/);
  assert.deepEqual(events, ["direct", "browser"]);
});

test("a recent paid failure backs off without another proxy call", async () => {
  const { opts, events } = harness({
    lastOk: ago(20 * 3600),
    paidAt: ago(60),
    lastProxyError: "blocked (challenge page)",
  });
  await assert.rejects(fetchJack(opts), /blocked \(challenge page\)/);
  assert.deepEqual(events, ["direct", "browser"]);
});

test("a fresh board skips the paid step until the cadence is due", async () => {
  const { opts, events } = harness({ lastOk: ago(30 * 60) });
  const res = await fetchJack(opts);
  assert.equal(res.skip, "not due");
  assert.equal(res.expected_interval_s, JACK_PAID_CADENCE_S);
  assert.deepEqual(events, ["direct", "browser"]);
});

test("a 403 on a later scrapedo call does not send the remaining urls back to scrapedo", async () => {
  const { opts, events } = harness();
  let n = 0;
  opts.scrapedo = async (url) => {
    events.push("scrapedo");
    n += 1;
    if (n === 1) return payload(url);
    throw new Error("scrapedo HTTP 403");
  };
  const res = await fetchJack(opts);
  assert.equal(res.via, "scrapedo+firecrawl");
  assert.equal(events.filter((e) => e === "scrapedo").length, 2);
  assert.equal(events.filter((e) => e === "firecrawl").length, 2);
});
