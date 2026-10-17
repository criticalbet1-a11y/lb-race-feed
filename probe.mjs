import { chromium } from "playwright";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const b = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
for (let round = 1; round <= 3; round++) {
  const ctx = await b.newContext({ userAgent: UA, locale: "en-US" });
  const p = await ctx.newPage();
  try {
    const r = await p.goto("https://tower.bet/monthly-contest", { waitUntil: "domcontentloaded", timeout: 30000 });
    for (let i = 0; i < 20 && /just a moment|attention/i.test(await p.title()); i++) await p.waitForTimeout(1000);
    const out = await p.evaluate(async () => {
      const g = async (u) => { const x = await fetch(u); const t = await x.text(); return [x.status, t]; };
      const [s1, t1] = await g("/api/monthly-event/current");
      let hash = null; try { hash = JSON.parse(t1).wageringContestHash; } catch {}
      const [s2, t2] = hash ? await g(`/api/race/leaderboard/${hash}`) : [0, ""];
      const [s3] = await g("/api/race/type/tournament");
      let leaders = 0; try { leaders = JSON.parse(t2).leaders.length; } catch {}
      return `current=${s1} hash=${hash} leaderboard=${s2} leaders=${leaders} tournament=${s3}`;
    });
    console.log(`PROBE tower round${round}: page=${r?.status()} title="${await p.title()}" ${out}`);
  } catch (e) { console.log(`PROBE tower round${round}: ERR ${e.message.split("\n")[0]}`); }
  await ctx.close();
  await new Promise((r) => setTimeout(r, 5000));
}
await b.close();
