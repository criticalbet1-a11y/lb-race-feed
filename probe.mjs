import { chromium } from "playwright";
const targets = [
  ["frogbet", "https://frogbet.com/wager-race/", "https://api.frogbet.com/api/v1/wager-race/leaderboard"],
  ["duckdice", "https://duckdice.io/monthly-event/leaderboard", "https://duckdice.io/api/contest/type/wagering"],
  ["tower", "https://tower.bet/monthly-contest", "https://tower.bet/api/monthly-event/current"],
];
const b = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", locale: "en-US" });
for (const [id, page, api] of targets) {
  const p = await ctx.newPage();
  try {
    const r = await p.goto(page, { waitUntil: "domcontentloaded", timeout: 30000 });
    await p.waitForTimeout(8000);
    const title = await p.title();
    const res = await p.evaluate(async (u) => { try { const x = await fetch(u, { credentials: "include" }); const t = await x.text(); return `${x.status} ${t.slice(0, 120)}`; } catch (e) { return "ERR " + e; } }, api);
    console.log(`PROBE ${id}: page=${r?.status()} title="${title}" api=${res.replace(/\s+/g, " ")}`);
  } catch (e) { console.log(`PROBE ${id}: ERR ${e.message.split("\n")[0]}`); }
  await p.close();
}
await b.close();
