// Race feed scraper. Each source has its own fetch strategy + cadence:
//   jack     direct -> headless Chromium -> Scrape.do (Firecrawl only if Scrape.do fails), every run
//            paid step only after a block, at most every 12 h (3 calls: list + casino boards)
//   duckdice direct -> headless Chromium (Playwright) fallback, every run
//   tower    Firecrawl (DE) / Scrape.do (DE), budget-paced (~25 min contest, 4 h weekly tournament)
//   frogbet  direct -> Microlink (no key, <=20/day, ~72 min) -> Firecrawl/Scrape.do if budget allows
// Usage: node --experimental-strip-types scrape.mjs <dir>
//   reads/writes <dir>/races.json (live `races` + frozen `finished`) and <dir>/state.json
// Secrets come from env (FIRECRAWL_API_KEY, SCRAPEDO_TOKEN) and are never written or logged.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FINISHED_CAP, mergeFinished, periodKey, priorLive, splitPrev } from "./src/archive.ts";
import { ADAPTERS } from "./src/races.ts";

const DIR = process.argv[2] || "out";
const FC_KEY = process.env.FIRECRAWL_API_KEY || "";
const FC_KEY2 = process.env.FIRECRAWL_API_KEY_2 || ""; // standby only: used when key 1 is out of credits / rejected
const SD_TOKEN = process.env.SCRAPEDO_TOKEN || "";
const FC_KEYS = { firecrawl: FC_KEY, firecrawl2: FC_KEY2 };
const SECRETS = [FC_KEY, FC_KEY2, SD_TOKEN, encodeURIComponent(SD_TOKEN)].filter((s) => s.length > 6);
const scrub = (s) => SECRETS.reduce((a, k) => a.split(k).join("***"), String(s)).slice(0, 160);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MIN = 60_000;

/* ---------------- cadence (seconds, also published so the site can judge freshness) ---------------- */
const CADENCE = { jack: 600, duckdice: 600, frogbet: 72 * 60, "tower-contest": 25 * 60, "tower-tournament": 4 * 3600 };
// One Jack refresh is the active-board list plus one tournament payload per casino
// board (sports is not requested): 3 calls today. Every 10 min would spend the
// shared day pace Tower needs. 12 h is 6 calls/day and still fits that spare.
export const JACK_PAID_CADENCE_S = 12 * 3600;
export const JACK_PAID_CALLS = 3;
const TOWER_EVENT_TTL = 12 * 3600_000; // re-lookup the current monthly contest hash at most ~2x/day
const MONTH_CAP = 950; // per paid-proxy provider, per calendar month (UTC)
const DAY_CAP = 45;
const MICROLINK_DAY_CAP = 20; // keyless limit is 25/day

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return d; } };
const prev = readJSON("races.json", {});
const state = readJSON("state.json", {});
state.budget ??= {};
state.tower ??= {};
state.last ??= {};

/* ---------------- budget guard ---------------- */
function bucket(p, now) {
  const d = new Date(now).toISOString();
  const b = (state.budget[p] ??= {});
  if (b.month !== d.slice(0, 7)) Object.assign(b, { month: d.slice(0, 7), used_month: 0 });
  if (b.day !== d.slice(0, 10)) Object.assign(b, { day: d.slice(0, 10), used_day: 0 });
  return b;
}
/** Calls still allowed right now: monthly cap spread over remaining days, paced through the day. */
function allowance(p, now) {
  const b = bucket(p, now);
  if (p === "microlink") return MICROLINK_DAY_CAP - b.used_day;
  if (p.startsWith("firecrawl") && (!FC_KEYS[p] || fcDown(p, now))) return 0;
  if (p === "firecrawl2" && !fcDown("firecrawl", now)) return 0; // standby: only when key 1 is unusable
  if (p === "scrapedo" && !SD_TOKEN) return 0;
  const d = new Date(now);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = dim - d.getUTCDate() + 1;
  const daily = Math.min(DAY_CAP, Math.floor((MONTH_CAP - (b.used_month - b.used_day)) / daysLeft));
  const frac = (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400_000;
  const paced = Math.min(daily, Math.ceil(daily * frac) + 3);
  return Math.min(paced - b.used_day, MONTH_CAP - b.used_month);
}
/** A Firecrawl key is "down" after a credit/auth error (for 12 h) or when its reported remaining credits < 30. */
function fcDown(p, now) {
  const b = state.budget[p] || {};
  if (b.down_until && now < Date.parse(b.down_until)) return true;
  return typeof b.remaining === "number" && b.remaining - (b.used_since_check || 0) < 30;
}
function spend(p, now) {
  const b = bucket(p, now);
  b.used_day++; b.used_month++;
  if (p.startsWith("firecrawl")) b.used_since_check = (b.used_since_check || 0) + 1;
}

async function firecrawlCreditCheck(p, now) {
  if (!FC_KEYS[p]) return;
  const b = bucket(p, now);
  if (b.checked_at && now - Date.parse(b.checked_at) < 86400_000) return;
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", { headers: { authorization: `Bearer ${FC_KEYS[p]}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const rem = Number(j?.data?.remainingCredits ?? j?.data?.remaining_credits);
    if (r.ok && Number.isFinite(rem)) Object.assign(b, { remaining: rem, used_since_check: 0, checked_at: new Date(now).toISOString() });
    if (r.status === 401 || r.status === 402 || r.status === 403) b.down_until = new Date(now + 12 * 3600_000).toISOString();
    console.log(`${p} credits remaining: ${Number.isFinite(rem) ? rem : "unknown"} (HTTP ${r.status})`);
  } catch (e) { console.log(`${p} credit check failed: ${scrub(e.message)}`); }
}

/* ---------------- fetch strategies ---------------- */
function parseBody(text) {
  let t = String(text ?? "").trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  if (/^</.test(t)) {
    if (/just a moment|cf-chl|challenge-platform|access denied/i.test(t)) throw new Error("blocked (challenge page)");
    const pre = t.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || t.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    t = (pre ? pre[1] : t).replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  }
  try { return JSON.parse(t); } catch { throw new Error("invalid JSON"); }
}

async function direct(url, referer, tries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": UA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", referer, origin: new URL(referer).origin } });
      const text = await res.text();
      if (!res.ok) throw new Error(/just a moment|cf-chl|challenge/i.test(text) ? `blocked (HTTP ${res.status} challenge)` : `HTTP ${res.status}`);
      return parseBody(text);
    } catch (e) {
      if (i + 1 >= tries || !/403|429|5\d\d|blocked|fetch failed|timeout|abort/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function viaFirecrawl(url, now, p = "firecrawl") {
  if (allowance(p, now) <= 0) throw new Error(`${p} budget exhausted`);
  spend(p, now);
  const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: { authorization: `Bearer ${FC_KEYS[p]}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["rawHtml"], location: { country: "DE" }, maxAge: 0, storeInCache: false, onlyMainContent: false, timeout: 45000 }),
  });
  const j = await r.json().catch(() => ({}));
  if ([401, 402, 403, 429].includes(r.status) && /credit|auth|unauthori|invalid|payment|limit/i.test(JSON.stringify(j))) {
    // Out of credits / key rejected: park this key for 12 h (key 2 takes over if it is key 1).
    bucket(p, now).down_until = new Date(now + 12 * 3600_000).toISOString();
  }
  if (!r.ok || !j.success) throw new Error(`${p} HTTP ${r.status}${j.error ? ` ${scrub(j.error).slice(0, 80)}` : ""}`);
  const st = j.data?.metadata?.statusCode;
  if (st && st !== 200) throw new Error(`firecrawl target HTTP ${st}`);
  return parseBody(j.data?.rawHtml ?? j.data?.markdown);
}

async function viaScrapedo(url, now) {
  if (allowance("scrapedo", now) <= 0) throw new Error("scrapedo budget exhausted");
  const r = await fetch(`https://api.scrape.do/?token=${encodeURIComponent(SD_TOKEN)}&geoCode=de&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`scrapedo HTTP ${r.status}`);
  spend("scrapedo", now); // Scrape.do bills successful calls only
  return parseBody(text);
}

/** Paid proxy: whichever provider has more allowance left; the other one as fallback. */
async function viaProxy(url, now, used) {
  const order = ["scrapedo", "firecrawl"].sort((a, b) => allowance(b, now) - allowance(a, now));
  order.push("firecrawl2"); // standby; allowance() is 0 unless key 1 is down
  let err;
  for (const p of order) {
    if (allowance(p, now) <= 0) continue;
    try { const d = await (p === "scrapedo" ? viaScrapedo(url, now) : viaFirecrawl(url, now, p)); used.add(p); return d; }
    catch (e) { err = e; console.log(`  ${p} ${new URL(url).pathname}: ${scrub(e.message)}`); }
  }
  throw err ?? new Error("proxy budget exhausted");
}

async function viaMicrolink(url, now) {
  if (allowance("microlink", now) <= 0) throw new Error("microlink daily limit");
  spend("microlink", now);
  const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&force=true&meta=false&data.body.selector=body&data.body.attr=text`, { signal: AbortSignal.timeout(45000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== "success") throw new Error(`microlink HTTP ${r.status}`);
  const body = j.data?.body;
  return typeof body === "string" ? parseBody(body) : body;
}

let browser = null;
async function browserGetJSON(pageUrl) {
  const { chromium } = await import("playwright");
  browser ??= await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  for (let i = 0; i < 20 && /just a moment|attention/i.test(await page.title()); i++) await page.waitForTimeout(1000);
  return {
    get: async (url) => {
      const [status, text] = await page.evaluate(async (u) => { const x = await fetch(u, { headers: { accept: "application/json" } }); return [x.status, await x.text()]; }, url);
      if (status !== 200) throw new Error(`browser HTTP ${status}`);
      return parseBody(text);
    },
    close: () => ctx.close(),
  };
}

/* ---------------- per-source runners ---------------- */
const adapter = Object.fromEntries(ADAPTERS.map((a) => [a.id, a]));
const ageMin = (iso, now) => (iso ? (now - Date.parse(iso)) / MIN : Infinity);

const transportError = (msg) => /403|429|blocked|challenge|fetch failed|timeout|abort|5\d\d/i.test(String(msg ?? ""));
const errText = (e) => String(e?.message ?? e);

/** Which paid path Jack may start. Free paths are decided by the caller. */
export function jackPaidChoice(now, { lastOk, paidAt, allowances } = {}) {
  const age = (iso) => {
    const t = typeof iso === "string" ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? (now - t) / 1000 : Infinity;
  };
  if (age(lastOk) < JACK_PAID_CADENCE_S - 120) return { kind: "skip" };
  if (age(paidAt) < JACK_PAID_CADENCE_S - 120) return { kind: "backoff" };
  const sd = allowances?.scrapedo ?? 0;
  const fc = Math.max(allowances?.firecrawl ?? 0, allowances?.firecrawl2 ?? 0);
  if (sd >= JACK_PAID_CALLS) return { kind: "scrapedo" };
  if (fc >= JACK_PAID_CALLS) return { kind: "firecrawl" };
  return { kind: "exhausted" };
}

/**
 * Jack order: direct, then headless Chromium, then Scrape.do, then Firecrawl.
 * Paid calls run only after a transport failure, and at most once per cadence
 * (a failed paid attempt backs off the same way, so Firecrawl is not charged
 * on every 10-minute loop). Scrape.do wins when it has a full refresh left,
 * even if Firecrawl has more allowance.
 */
export async function fetchJack(opts) {
  try {
    return { races: await opts.run((u, r) => opts.direct(u, r), "direct"), via: "direct", expected_interval_s: CADENCE.jack };
  } catch (e) {
    if (!transportError(errText(e))) throw e;
    console.log(`  jack direct: ${scrub(errText(e))} -> browser`);
  }
  try {
    const b = await opts.browser();
    try {
      return { races: await opts.run((u) => b.get(u), "browser"), via: "browser", expected_interval_s: CADENCE.jack };
    } finally { await Promise.resolve(b?.close?.()).catch(() => {}); }
  } catch (e) {
    const msg = errText(e);
    if (!transportError(msg) && !/playwright|chromium|executable|browserType/i.test(msg)) throw e;
    console.log(`  jack browser: ${scrub(msg)} -> proxy`);
  }
  const choice = jackPaidChoice(opts.now, opts);
  if (choice.kind === "skip") return { skip: "not due", expected_interval_s: JACK_PAID_CADENCE_S };
  if (choice.kind === "backoff") {
    console.log("  jack proxy: backoff");
    throw new Error(opts.lastProxyError || "jack proxy backoff");
  }
  if (choice.kind !== "scrapedo" && choice.kind !== "firecrawl") throw new Error("jack proxy budget exhausted");
  opts.onPaidAttempt?.(opts.now);
  const allowances = opts.allowances ?? {};
  const fcProviders = ["firecrawl", "firecrawl2"].filter((p) => (allowances[p] ?? 0) >= JACK_PAID_CALLS);
  let skipScrapedo = choice.kind !== "scrapedo";
  const used = new Set();
  const getJSON = async (url) => {
    if (!skipScrapedo) {
      try {
        const data = await opts.scrapedo(url);
        used.add("scrapedo");
        return data;
      } catch (e) {
        const msg = errText(e);
        console.log(`  jack scrapedo: ${scrub(msg)}`);
        if (/403|blocked|challenge/i.test(msg)) skipScrapedo = true;
        if (!fcProviders.length) throw e;
      }
    }
    let err;
    for (const p of fcProviders) {
      try {
        const data = await opts.firecrawl(url, p);
        used.add(p);
        return data;
      } catch (e) {
        err = e;
        console.log(`  jack ${p}: ${scrub(errText(e))}`);
      }
    }
    throw err ?? new Error("jack proxy budget exhausted");
  };
  try {
    const races = await opts.run(getJSON, choice.kind);
    opts.onPaidSuccess?.();
    return { races, via: [...used].join("+") || choice.kind, expected_interval_s: JACK_PAID_CADENCE_S };
  } catch (e) {
    opts.onPaidFailure?.(errText(e));
    throw e;
  }
}

const RUNNERS = {
  async jack(now) {
    return fetchJack({
      now,
      lastOk: state.last?.jack ?? null,
      paidAt: state.jack?.paid_at ?? null,
      lastProxyError: state.jack?.error ?? null,
      allowances: {
        scrapedo: allowance("scrapedo", now),
        firecrawl: allowance("firecrawl", now),
        firecrawl2: allowance("firecrawl2", now),
      },
      run: (getJSON, via) => adapter.jack.run({ now: via === "direct" ? now : Date.now(), getJSON }),
      direct: (url, referer) => direct(url, referer),
      browser: () => browserGetJSON("https://jack.com/en/tournaments"),
      scrapedo: (url) => viaScrapedo(url, now),
      firecrawl: (url, provider) => viaFirecrawl(url, now, provider),
      onPaidAttempt: () => {
        state.jack ??= {};
        state.jack.paid_at = new Date(now).toISOString();
      },
      onPaidFailure: (message) => {
        state.jack ??= {};
        state.jack.error = scrub(message);
      },
      onPaidSuccess: () => { if (state.jack) delete state.jack.error; },
    });
  },
  async duckdice(now) {
    try { return { races: await adapter.duckdice.run({ now, getJSON: (u, r) => direct(u, r) }), via: "direct" }; }
    catch (e) {
      console.log(`  duckdice direct: ${e.message} -> browser`);
      const b = await browserGetJSON("https://duckdice.io/monthly-event/leaderboard");
      try { return { races: await adapter.duckdice.run({ now: Date.now(), getJSON: (u) => b.get(u) }), via: "browser" }; }
      finally { await b.close(); }
    }
  },
  async frogbet(now) {
    try { return { races: await adapter.frogbet.run({ now, getJSON: (u, r) => direct(u, r, 1) }), via: "direct" }; }
    catch (e) { console.log(`  frogbet direct: ${e.message}`); }
    if (ageMin(state.last.frogbet, now) < CADENCE.frogbet / 60 - 2) return { skip: "not due" };
    try { return { races: await adapter.frogbet.run({ now: Date.now(), getJSON: (u) => viaMicrolink(u, now) }), via: "microlink" }; }
    catch (e) { console.log(`  frogbet microlink: ${e.message}`); }
    const used = new Set();
    return { races: await adapter.frogbet.run({ now: Date.now(), getJSON: (u) => viaProxy(u, now, used) }), via: [...used].join("+") };
  },
  async tower(now) {
    const t = state.tower;
    if (ageMin(state.last["tower-contest"], now) < CADENCE["tower-contest"] / 60 - 2) return { skip: "not due" };
    const tournamentDue = ageMin(state.last["tower-tournament"], now) >= CADENCE["tower-tournament"] / 60 - 2;
    const used = new Set();
    let tournamentFetched = false;
    const getJSON = async (url) => {
      if (url.endsWith("/api/monthly-event/current")) {
        const cached = t.event && Date.now() - Date.parse(t.event_at) < TOWER_EVENT_TTL && !(t.event.finishDate * 1000 <= Date.now());
        if (cached) return t.event;
        const ev = await viaProxy(url, now, used);
        const keep = (k) => (typeof ev?.[k] === "string" && /^[a-z0-9]{6,20}$/i.test(ev[k]) ? ev[k] : null);
        t.event = { wageringContestHash: keep("wageringContestHash"), finishDate: Number(ev?.finishDate) || null };
        t.event_at = new Date().toISOString();
        return t.event;
      }
      if (url.includes("/api/race/type/tournament")) {
        if (!tournamentDue) throw new Error("tournament not due");
        const d = await viaProxy(url, now, used);
        tournamentFetched = true;
        return d;
      }
      try { return await viaProxy(url, now, used); }
      catch (e) { delete t.event; throw e; } // stale hash? look it up again next time
    };
    const races = await adapter.tower.run({ now: Date.now(), getJSON });
    return { races, via: [...used].join("+") || "cache", tournamentFetched };
  },
};

/* ---------------- sanitize ---------------- */
const clean = (s, n) => (typeof s === "string" ? s.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f<>"`]/g, "").replace(/\s+/g, " ").trim().slice(0, n) : null);
const okNum = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const okIso = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s) && Number.isFinite(Date.parse(s));
function sanitizeRace(r, { finished = false } = {}) {
  if (!r || !/^[a-z0-9-]{3,60}$/.test(r.id) || !["frogbet", "jack", "duckdice", "tower"].includes(r.source_id)) return null;
  if (!["weekly", "monthly"].includes(r.cadence) || !okNum(r.prize_pool, 0, 5e6) || !okIso(r.ends_at) || !okIso(r.started_at) || !okIso(r.snapshot_at)) return null;
  if (finished && !okIso(r.finished_at)) return null;
  const leaderboard = (Array.isArray(r.leaderboard) ? r.leaderboard : []).slice(0, 30).flatMap((x) => {
    if (!okNum(x?.place, 1, 1000) || !okNum(x?.wagered, 0, 1e10)) return [];
    return [{ place: Math.round(x.place), player: clean(x.player, 24) || "Hidden", wagered: x.wagered, prize: okNum(x.prize, 0, 5e6) ? x.prize : null, prize_extra: clean(x.prize_extra, 40) }];
  });
  if (!leaderboard.length) return null;
  return {
    id: r.id, source_id: r.source_id, cadence: r.cadence, casino: clean(r.casino, 20), casino_logo: null, name: clean(r.name, 60) || "Race",
    prize_pool: r.prize_pool, prize_extra: clean(r.prize_extra, 60), currency: "USD", score_unit: r.score_unit === "points" ? "points" : "usd",
    points_per_dollar: okNum(r.points_per_dollar, 0, 1000) ? r.points_per_dollar : null,
    eligible_games: (Array.isArray(r.eligible_games) ? r.eligible_games : []).slice(0, 6).map((g) => clean(g, 40)).filter(Boolean),
    source: clean(r.source, 240), started_at: r.started_at, ends_at: r.ends_at,
    duration_seconds: okNum(r.duration_seconds, 3600, 40 * 86400) ? Math.round(r.duration_seconds) : 0,
    snapshot_at: r.snapshot_at, expected_interval_s: okNum(r.expected_interval_s, 60, 86400) ? r.expected_interval_s : 600,
    leaderboard, top_prizes: leaderboard.slice(0, 5).map((x) => x.prize ?? 0),
    ...(finished ? { finished_at: r.finished_at } : {}),
  };
}

/* ---------------- main ---------------- */
export { sanitizeRace };

async function main() {
  const started = Date.now();
  await firecrawlCreditCheck("firecrawl", started);
  if (fcDown("firecrawl", started)) await firecrawlCreditCheck("firecrawl2", started);
  // Previously-live rows, including ones whose ends_at has now passed. `unfinished`
  // is an older holding list if a snapshot wrote one; `races` wins on the same period.
  const prevLive = priorLive(prev.races, prev.unfinished);
  const prevFinished = Array.isArray(prev.finished) ? prev.finished : [];
  const prevHealth = Object.fromEntries((prev.health || []).map((h) => [h.id, h]));
  const health = [], live = [], toArchive = [];
  const intervalFor = (r) => (r.source_id === "tower" ? CADENCE[r.id.includes("tournament") ? "tower-tournament" : "tower-contest"] : CADENCE[r.source_id]);

  for (const a of ADAPTERS) {
    const now = Date.now();
    let res, error;
    try { res = await RUNNERS[a.id](now); } catch (e) { error = scrub(e.message || e); }
    const prevFor = prevLive.filter((x) => x.source_id === a.id);
    const stamped = res?.races?.length ? res.races.map((r) => ({ ...r, expected_interval_s: res.expected_interval_s ?? intervalFor(r) })) : null;
    // Ignore a payload that sanitizes to nothing so a bad body cannot erase the last good board.
    const usable = stamped?.filter((r) => sanitizeRace(r)) ?? null;
    const fetchedOk = Boolean(usable?.length);
    if (fetchedOk) {
      if (a.id === "tower") {
        state.last["tower-contest"] = new Date(now).toISOString();
        if (res.tournamentFetched) state.last["tower-tournament"] = new Date(now).toISOString();
      }
      state.last[a.id] = new Date(now).toISOString();
    }
    const split = splitPrev(prevFor, fetchedOk ? usable : null, now, {
      fetched: (old) => {
        if (!fetchedOk) return false;
        // Tower's weekly list is on a slower cadence. Not querying it is not "gone".
        if (a.id === "tower" && String(old.id).includes("tournament") && !res.tournamentFetched) return false;
        return true;
      },
      dropIfMissing: (old) => {
        if (!fetchedOk || a.id !== "tower" || !res.tournamentFetched || !String(old.id).includes("tournament")) return false;
        return !(res.races ?? []).some((r) => r.id === old.id);
      },
    });
    live.push(...split.live);
    toArchive.push(...split.archive);

    const ph = prevHealth[a.id] || {};
    const due = CADENCE[a.id] ?? CADENCE["tower-contest"];
    if (fetchedOk) {
      const keptNote = a.id === "tower" && !res.tournamentFetched && split.live.some((r) => String(r.id).includes("tournament"));
      health.push({ id: a.id, casino: a.casino, status: "ok", via: res.via, fetched_at: new Date(now).toISOString(), expected_interval_s: res.expected_interval_s ?? due, races: 0, ...(keptNote ? { note: "weekly tournament kept" } : {}) });
    } else if (res?.skip) {
      // Cadence skip is not a failure, even when every previous row just moved to finished.
      health.push({ id: a.id, casino: a.casino, status: "ok", via: ph.via ?? null, fetched_at: ph.fetched_at ?? state.last[a.id] ?? null, expected_interval_s: res.expected_interval_s ?? due, races: 0, note: res.skip });
    } else {
      health.push({ id: a.id, casino: a.casino, status: split.live.length ? "stale" : "error", via: ph.via ?? null, fetched_at: ph.fetched_at ?? state.last[a.id] ?? null, expected_interval_s: due, races: 0, error: error || "no running weekly/monthly race" });
    }
  }
  if (browser) await browser.close();

  const finishedAt = new Date().toISOString();
  const finished = mergeFinished(prevFinished, toArchive, finishedAt, FINISHED_CAP, (r) => sanitizeRace(r, { finished: true }));
  const finishedKeys = new Set(finished.map(periodKey));
  const races = [];
  for (const r of live) {
    const s = sanitizeRace(r);
    if (!s || finishedKeys.has(periodKey(s))) continue;
    races.push(s);
  }
  for (const h of health) h.races = races.filter((r) => r.source_id === h.id).length;

  const feed = { updated_at: new Date().toISOString(), health, races, finished };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "races.json"), JSON.stringify(feed, null, 1) + "\n");
  fs.writeFileSync(path.join(DIR, "state.json"), JSON.stringify(state, null, 1) + "\n");
  for (const h of health) console.log(`${h.id}: ${h.status} via=${h.via ?? "-"} fetched_at=${h.fetched_at ?? "-"} races=${h.races}${h.error ? ` error=${h.error}` : ""}${h.note ? ` (${h.note})` : ""}`);
  for (const r of feed.races) console.log(`  ${r.id} snap=${r.snapshot_at} ends=${r.ends_at} pool=${r.prize_pool} top3=${r.leaderboard.slice(0, 3).map((x) => `${x.place}.${x.player}:${x.wagered}`).join(" | ")}`);
  console.log(`finished: ${feed.finished.length}`);
  for (const r of feed.finished) console.log(`  done ${r.id} ends=${r.ends_at} finished_at=${r.finished_at} snap=${r.snapshot_at}`);
  for (const [p, b] of Object.entries(state.budget)) console.log(`budget ${p}: day=${b.used_day} month=${b.used_month}${b.remaining != null ? ` fc_remaining_at_check=${b.remaining}` : ""}`);
  if (state.jack?.paid_at) console.log(`jack paid_at=${state.jack.paid_at}${state.jack.error ? ` error=${state.jack.error}` : ""}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
