// Scrapes public weekly/monthly race leaderboards and writes out/races.json.
// Sources that fail keep their previous good data (from prev.json) marked stale.
import fs from "node:fs";
import { ADAPTERS } from "./src/races.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const TIMEOUT = 15000;

function getJSONFactory(signal) {
  const once = async (url, referer) => {
    let res;
    try {
      res = await fetch(url, { signal, headers: { "user-agent": UA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", referer, origin: new URL(referer).origin } });
    } catch { throw new Error(signal.aborted ? "timeout" : "network error"); }
    const text = await res.text();
    if (!res.ok) throw new Error(/just a moment|cf-chl|challenge/i.test(text) ? `blocked (HTTP ${res.status} challenge)` : `HTTP ${res.status}`);
    if (/^\s*</.test(text)) throw new Error("blocked (HTML instead of JSON)");
    try { return JSON.parse(text); } catch { throw new Error("invalid JSON"); }
  };
  return async (url, referer) => {
    for (let i = 0; ; i++) {
      try { return await once(url, referer); }
      catch (e) {
        if (i >= 2 || signal.aborted || !/403|429|5\d\d|blocked|network/.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
  };
}

let prev = {};
try { prev = JSON.parse(fs.readFileSync(process.argv[2] || "prev.json", "utf8")); } catch {}
const prevHealth = Object.fromEntries((prev.health || []).map((h) => [h.id, h]));

const now = Date.now();
const results = await Promise.allSettled(ADAPTERS.map(async (a) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT * 3);
  try { return await a.run({ now, getJSON: getJSONFactory(ctrl.signal) }); } finally { clearTimeout(t); }
}));

const health = [], races = [];
ADAPTERS.forEach((a, i) => {
  const r = results[i];
  if (r.status === "fulfilled" && r.value.length) {
    races.push(...r.value);
    health.push({ id: a.id, casino: a.casino, status: "ok", fetched_at: new Date(now).toISOString(), races: r.value.length });
    return;
  }
  const error = r.status === "rejected" ? String(r.reason?.message || r.reason) : "no running weekly/monthly race";
  const kept = (prev.races || []).filter((x) => x.source_id === a.id && Date.parse(x.ends_at) > now);
  races.push(...kept);
  health.push({ id: a.id, casino: a.casino, status: kept.length ? "stale" : "error", fetched_at: kept.length ? prevHealth[a.id]?.fetched_at ?? null : null, races: kept.length, error });
});

const feed = { updated_at: new Date(now).toISOString(), health, races };
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/races.json", JSON.stringify(feed, null, 1) + "\n");
for (const h of health) console.log(`${h.id}: ${h.status} races=${h.races}${h.error ? ` error=${h.error}` : ""}`);
for (const r of races) console.log(`  ${r.id} pool=${r.prize_pool} top3=${r.leaderboard.slice(0, 3).map((x) => `${x.place}.${x.player}:${x.wagered}`).join(" | ")}`);
