/**
 * Race Hub scraper: adapters that read each casino's PUBLIC, unauthenticated
 * race/leaderboard JSON and normalize it to our races contract
 * (see docs/race-scraper.md). Used by functions/api/races.ts.
 *
 * Rules every adapter follows:
 *  - Only weekly (5-10 days) and monthly (25-35 days) races. Daily, hourly
 *    and "promo" races are skipped here AND by the client parser.
 *  - Sports FreeBet boards are not casino wager races. Jack sports
 *    tournaments are skipped here and are never archived.
 *  - Player names leave this file masked (first 3 chars + *****); hidden /
 *    ghost players become "Hidden". Raw usernames are never sent.
 *  - No partner or source URLs in the output. Endpoints stay server-side.
 *  - Numbers come from the casino's data. Static facts (eligible games,
 *    points-per-dollar, a short source note) are the only hand-written parts.
 */

export type Cadence = "weekly" | "monthly";

export interface Row {
  place: number;
  player: string;
  wagered: number;
  prize: number | null;
  prize_extra: string | null;
}

export interface NormRace {
  id: string;
  source_id: string;
  cadence: Cadence;
  casino: string;
  casino_logo: null;
  name: string;
  prize_pool: number;
  prize_extra: string | null;
  currency: "USD";
  score_unit: "usd" | "points";
  points_per_dollar: number | null;
  eligible_games: string[];
  source: string;
  started_at: string;
  ends_at: string;
  duration_seconds: number;
  snapshot_at: string;
  leaderboard: Row[];
  top_prizes: number[];
  updating?: boolean;
  /** Set only on a frozen row in `finished`. Absent on live races. */
  finished_at?: string;
}

export interface Adapter {
  id: string;
  casino: string;
  /** Human-readable endpoint description for docs/health (never a partner URL). */
  endpoint: string;
  run: (ctx: AdapterCtx) => Promise<NormRace[]>;
}

export interface AdapterCtx {
  now: number;
  getJSON: (url: string, referer: string) => Promise<unknown>;
}

const DAY = 86400;
const MAX_ROWS = 30;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[,$\s_]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** first 3 chars + *****; already-masked names kept; empty/hidden -> Hidden. */
export function mask(name: unknown): string {
  const n = str(name);
  if (!n || /^(ninja|hidden|anonymous|ghost)$/i.test(n)) return "Hidden";
  if (/[*•]/.test(n)) return n;
  return `${n.slice(0, Math.min(3, Math.max(1, n.length - 1)))}*****`;
}

export function cadenceFor(durationSec: number): Cadence | null {
  if (durationSec >= 5 * DAY && durationSec <= 10 * DAY) return "weekly";
  if (durationSec >= 25 * DAY && durationSec <= 35 * DAY) return "monthly";
  return null;
}

const fmtInt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
const round2 = (n: number) => Math.round(n * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function finish(r: Omit<NormRace, "top_prizes" | "leaderboard"> & { leaderboard: Row[] }): NormRace {
  const leaderboard = r.leaderboard
    .filter((x) => x.place > 0 && Number.isFinite(x.wagered))
    .sort((a, b) => a.place - b.place)
    .slice(0, MAX_ROWS);
  return { ...r, leaderboard, top_prizes: leaderboard.slice(0, 5).map((x) => x.prize ?? 0) };
}

/* -------------------------------------------------------------------------- */
/* FrogBet: weekly Wager Race. GET api.frogbet.com/api/v1/wager-race/leaderboard */
/* -------------------------------------------------------------------------- */
const frogbet: Adapter = {
  id: "frogbet",
  casino: "FrogBet",
  endpoint: "api.frogbet.com/api/v1/wager-race/leaderboard",
  async run({ now, getJSON }) {
    const d = await getJSON("https://api.frogbet.com/api/v1/wager-race/leaderboard", "https://frogbet.com/wager-race/");
    if (!isObj(d) || !isObj(d.week)) throw new Error("unexpected shape");
    const left = num(d.week.time_remaining_seconds);
    const pool = num(d.week.total_prize_pool_usd);
    if (left === null || pool === null) throw new Error("missing week fields");
    // Round the end to the minute: the payload is seconds-left at fetch time.
    const ends = Math.round((now + left * 1000) / 60000) * 60000;
    const start = ends - 7 * DAY * 1000;
    const rows: Row[] = arr(d.leaderboard).flatMap((x) => {
      if (!isObj(x)) return [];
      const place = num(x.position);
      const w = num(x.wagered_usd);
      if (place === null || w === null) return [];
      return [{ place, player: mask(x.username), wagered: round2(w), prize: num(x.prize_usd), prize_extra: null }];
    });
    return [
      finish({
        id: "frogbet-weekly-wager-race",
        source_id: "frogbet",
        cadence: "weekly",
        casino: "FrogBet",
        casino_logo: null,
        name: "Weekly Wager Race",
        prize_pool: pool,
        prize_extra: null,
        currency: "USD",
        score_unit: "usd",
        points_per_dollar: null,
        eligible_games: ["All games"],
        source: "FrogBet public wager-race leaderboard (frogbet.com/wager-race). Resets Wednesdays 00:00 UTC.",
        started_at: iso(start),
        ends_at: iso(ends),
        duration_seconds: 7 * DAY,
        snapshot_at: iso(now),
        leaderboard: rows,
      }),
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* Jack: casino weekly/monthly tournaments. Sports FreeBet boards are excluded. */
/*   GET jack.com/api/leaderBoard/getActiveLeaderBoards                     */
/*   + getLeaderBoardTournamentInfo?leaderBoardId=<id> (currentPrize)       */
/*   Window is CurrentStartDate/CurrentEndDate when present, so a one-shot  */
/*   week is not cut down to the next Wednesday.                            */
/* -------------------------------------------------------------------------- */

/** Sports FreeBet boards stay out of the casino feed (live and finished). */
function isJackSportsBoard(b: Obj): boolean {
  const bits = [b.TypeName, b.LeaderBoardName, b.Title, b.ShortDescription, b.LeaderBoardDesigneTypeName];
  return bits.some((v) => /\bsports?\b|\bsportsbook\b/i.test(str(v) ?? ""));
}

function parseJackDate(v: unknown): number {
  const s = str(v);
  if (!s) return NaN;
  return Date.parse(/Z$/i.test(s) ? s : `${s}Z`);
}

function jackPeriod(b: Obj, now: number, weekly: boolean): { started: number; ends: number; dur: number } | null {
  const curStart = parseJackDate(b.CurrentStartDate);
  const curEnd = parseJackDate(b.CurrentEndDate);
  // Current dates exist: this window is the race. If it has already ended, do not
  // relabel the same leaderboard as next Wednesday.
  if (Number.isFinite(curStart) && Number.isFinite(curEnd) && curEnd > curStart) {
    if (curEnd <= now) return null;
    return { started: curStart, ends: curEnd, dur: Math.round((curEnd - curStart) / 1000) };
  }
  const campaignEnd = parseJackDate(b.EndDate);
  const campaignStart = parseJackDate(b.StartDate);
  if (weekly) {
    let ends = nextJackReset(now);
    if (Number.isFinite(campaignEnd) && campaignEnd < ends) ends = campaignEnd;
    if (!Number.isFinite(ends) || ends <= now) return null;
    return { started: ends - 7 * DAY * 1000, ends, dur: 7 * DAY };
  }
  if (!Number.isFinite(campaignEnd) || campaignEnd <= now) return null;
  const campaignDur = (campaignEnd - campaignStart) / 1000;
  const dur = cadenceFor(campaignDur) ? campaignDur : 30 * DAY;
  const started = Number.isFinite(campaignStart) ? campaignStart : campaignEnd - dur * 1000;
  return { started, ends: campaignEnd, dur };
}

/** Next weekly reset (Wednesday 12:00 UTC) strictly after `now`. */
export function nextJackReset(now: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
  const dow = new Date(t).getUTCDay(); // 3 = Wednesday
  let next = t + ((3 - dow + 7) % 7) * DAY * 1000;
  if (next <= now) next += 7 * DAY * 1000;
  return next;
}

const jack: Adapter = {
  id: "jack",
  casino: "Jack",
  endpoint: "jack.com/api/leaderBoard/getActiveLeaderBoards + getLeaderBoardTournamentInfo",
  async run({ now, getJSON }) {
    const ref = "https://jack.com/en/tournaments";
    const list = await getJSON("https://jack.com/api/leaderBoard/getActiveLeaderBoards?languageId=1", ref);
    if (!Array.isArray(list)) throw new Error("unexpected shape");
    const boards = list.filter(
      (b): b is Obj =>
        isObj(b) && b.LeaderBoardStatus === 1 && /^(weekly|monthly)$/i.test(str(b.TypeName) ?? "") && !isJackSportsBoard(b),
    );
    if (!boards.length) throw new Error("no active weekly/monthly leaderboard");
    const out: NormRace[] = [];
    for (const b of boards) {
      const id = num(b.Id);
      if (id === null) continue;
      const weekly = /weekly/i.test(str(b.TypeName) ?? "");
      const period = jackPeriod(b, now, weekly);
      if (!period) continue;
      const cadence = cadenceFor(period.dur);
      if (!cadence) continue;
      const info = await getJSON(`https://jack.com/api/leaderBoard/getLeaderBoardTournamentInfo?languageId=1&leaderBoardId=${id}`, `${ref}/${id}`);
      if (!isObj(info)) throw new Error("unexpected tournament info");
      const rows: Row[] = arr(info.currentPrize).flatMap((x) => {
        if (!isObj(x)) return [];
        const place = num(x.place);
        const pts = num(x.point);
        if (place === null || pts === null) return [];
        const amount = num(x.amount);
        return [{ place, player: mask(x.userName), wagered: Math.round(pts), prize: amount && amount > 0 ? amount : null, prize_extra: str(x.prize) }];
      });
      // Listed prizes are this window. PrizeFund is the whole campaign.
      const pool = rows.reduce((s, r) => s + (r.prize ?? 0), 0);
      const rule = (str(b.Rule) ?? "").replace(/&quot;/g, '"');
      const quoted = rule.match(/"([A-Z][A-Za-z' ]{2,40})"/)?.[1];
      const fromBoard = (str(b.LeaderBoardName) ?? "Weekly Tournament").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      // Id stays on the historical slug so a clearer title does not fork the row.
      const legacyName = quoted ?? fromBoard;
      const title = (str(b.Title) ?? "").replace(/[\u2018\u2019]/g, "'");
      const genericTitle = !title || /^(weekly|monthly)\b/i.test(title);
      const name = quoted ?? (genericTitle ? fromBoard : title);
      const fund = str(b.PrizeFund);
      const campaignEnd = parseJackDate(b.EndDate);
      const recurring = weekly && Number.isFinite(campaignEnd) && campaignEnd > period.ends + 36 * 3600 * 1000;
      out.push(
        finish({
          id: `jack-${slug(legacyName)}`,
          source_id: "jack",
          cadence,
          casino: "Jack",
          casino_logo: null,
          name,
          prize_pool: pool,
          prize_extra: null,
          currency: "USD",
          score_unit: "points",
          points_per_dollar: 1,
          eligible_games: ["Slots", "Live casino"],
          source: `JACK public tournament leaderboard (jack.com/en/tournaments/${id}). 1 point per $1 wagered.${recurring ? " Resets Wednesdays 12:00 UTC." : ""}${fund ? ` Campaign prize fund ${fund.replace(/\s/g, ",")}.` : ""}`,
          started_at: iso(period.started),
          ends_at: iso(period.ends),
          duration_seconds: period.dur,
          snapshot_at: iso(now),
          leaderboard: rows,
        }),
      );
    }
    return out;
  },
};

/* -------------------------------------------------------------------------- */
/* DuckDice + Tower share a platform: contests expose leaders + rewards.      */
/* -------------------------------------------------------------------------- */

function rewardParts(rewards: unknown): { usd: number | null; extra: string | null } {
  // DuckDice shape: {amountUSD, additionalAmount, additionalSymbol}
  // Tower shape:    {USD:{amount}, DECOY:{amount, symbol}}
  if (!isObj(rewards)) return { usd: null, extra: null };
  if ("amountUSD" in rewards) {
    const add = num(rewards.additionalAmount);
    const sym = str(rewards.additionalSymbol);
    return { usd: num(rewards.amountUSD), extra: add && sym ? `${fmtInt(add)} ${sym}` : null };
  }
  let usd: number | null = null;
  const extras: string[] = [];
  for (const [k, v] of Object.entries(rewards)) {
    if (!isObj(v)) continue;
    const amt = num(v.amount);
    if (amt === null) continue;
    if (k === "USD") usd = amt;
    else if (amt > 0) extras.push(`${fmtInt(amt)} ${str(v.symbol) ?? k}`);
  }
  return { usd, extra: extras.length ? extras.join(" + ") : null };
}

const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

/** `trunc`: Tower shows volumes truncated to cents, DuckDice rounds. Match each site. */
function contestRows(leaders: unknown, rewardKey: "reward" | "rewards", trunc = false): Row[] {
  return arr(leaders).flatMap((x) => {
    if (!isObj(x)) return [];
    const place = num(x.rank);
    const vol = num(x.volume);
    if (place === null || vol === null) return [];
    const u = isObj(x.user) ? x.user : {};
    const hidden = u.hidden === true || u.isGhost === true || !str(u.username);
    const { usd, extra } = rewardParts(x[rewardKey]);
    return [{ place, player: hidden ? "Hidden" : mask(u.username), wagered: trunc ? floor2(vol) : round2(vol), prize: usd && usd > 0 ? usd : null, prize_extra: extra }];
  });
}

const duckdice: Adapter = {
  id: "duckdice",
  casino: "DuckDice",
  endpoint: "duckdice.io/api/contest/type/{wagering,limited-wagering,external-casino-tournament}",
  async run({ now, getJSON }) {
    const ref = "https://duckdice.io/monthly-event/leaderboard";
    const out: NormRace[] = [];
    let seen = 0;
    // "wagering" = Monthly Contest (required); the others are weekly tournaments (optional).
    for (const type of ["wagering", "limited-wagering", "external-casino-tournament"]) {
      let d: unknown;
      try {
        d = await getJSON(`https://duckdice.io/api/contest/type/${type}`, ref);
      } catch (e) {
        if (type === "wagering") throw e;
        continue;
      }
      if (!isObj(d)) {
        if (type === "wagering") throw new Error("unexpected shape");
        continue;
      }
      if (type === "wagering") seen++;
      for (const c of arr(d.current)) {
        if (!isObj(c) || str(c.status) !== "running") continue;
        const start = num(c.startDate);
        const end = num(c.endDate);
        if (start === null || end === null || end * 1000 <= now) continue;
        const cadence = cadenceFor(end - start);
        if (!cadence) continue;
        const rw = isObj(c.rewards) ? c.rewards : {};
        const pool = num(rw.poolAmountUSD) ?? 0;
        const addPool = num(rw.additionalPoolAmount);
        const addSym = str(rw.additionalRewardSymbol);
        const name = str(c.name) ?? "Contest";
        const contest = type === "wagering";
        out.push(
          finish({
            // Tournament names change weekly; keep a stable id per kind.
            id: contest ? `duckdice-${slug(name)}` : `duckdice-${cadence}-tournament`,
            source_id: "duckdice",
            cadence,
            casino: "DuckDice",
            casino_logo: null,
            name,
            prize_pool: pool,
            prize_extra: addPool && addSym ? `${fmtInt(addPool)} ${addSym}` : null,
            currency: "USD",
            score_unit: "usd",
            points_per_dollar: null,
            eligible_games: contest ? ["Dice", "Sports"] : type === "external-casino-tournament" ? ["Selected slots only"] : [],
            source: contest
              ? "DuckDice public contest leaderboard (duckdice.io/monthly-event). Volume in USD; DuckDice counts wagers at a 1% house-edge rate."
              : "DuckDice public weekly tournament leaderboard (duckdice.io bonuses). Volume = USD wagered on the tournament's games.",
            started_at: iso(start * 1000),
            ends_at: iso(end * 1000),
            duration_seconds: end - start,
            snapshot_at: iso(now),
            leaderboard: contestRows(c.leaders, "reward"),
          }),
        );
      }
    }
    if (!seen) throw new Error("no contest data");
    return out;
  },
};

function towerPool(rewards: unknown): { usd: number; extra: string | null } {
  const pools = isObj(rewards) && isObj(rewards.pools) ? rewards.pools : {};
  let usd = 0;
  const extras: string[] = [];
  for (const [k, v] of Object.entries(pools)) {
    if (!isObj(v)) continue;
    const amt = num(v.amount);
    if (amt === null) continue;
    if (k === "USD") usd = amt;
    else if (amt > 0) extras.push(`${fmtInt(amt)} ${str(v.symbol) ?? k}`);
  }
  return { usd, extra: extras.length ? extras.join(" + ") : null };
}

const tower: Adapter = {
  id: "tower",
  casino: "Tower",
  endpoint: "tower.bet/api/monthly-event/current -> /api/race/leaderboard/<hash>; /api/race/type/tournament",
  async run({ now, getJSON }) {
    const out: NormRace[] = [];
    // Monthly wagering contest.
    const ev = await getJSON("https://tower.bet/api/monthly-event/current", "https://tower.bet/monthly-contest");
    const hash = isObj(ev) ? str(ev.wageringContestHash) : null;
    if (!hash || !/^[a-z0-9]{6,20}$/i.test(hash)) throw new Error("no monthly contest hash");
    const lb = await getJSON(`https://tower.bet/api/race/leaderboard/${hash}`, "https://tower.bet/monthly-contest");
    if (!isObj(lb)) throw new Error("unexpected leaderboard shape");
    const push = (c: Obj, kind: "contest" | "tournament") => {
      const start = num(c.startDate);
      const end = num(c.endDate);
      if (start === null || end === null || end * 1000 <= now || str(c.status) !== "running") return;
      const cadence = cadenceFor(end - start);
      if (!cadence) return;
      const { usd, extra } = towerPool(c.rewards);
      const rules = isObj(c.rules) ? c.rules : {};
      const name = str(c.name) ?? (kind === "contest" ? "Monthly Contest" : "Weekly Tournament");
      out.push(
        finish({
          id: kind === "contest" ? "tower-monthly-contest" : "tower-weekly-tournament",
          source_id: "tower",
          cadence,
          casino: "Tower",
          casino_logo: null,
          name,
          prize_pool: usd,
          prize_extra: extra,
          currency: "USD",
          score_unit: "usd",
          points_per_dollar: null,
          eligible_games:
            kind === "contest"
              ? ["All games (not TWG or DECOY)"]
              : Array.isArray(rules.gamesToWager) && rules.gamesToWager.length
                ? ["Selected slots only"]
                : [],
          source:
            kind === "contest"
              ? "Tower public monthly contest leaderboard (tower.bet/monthly-contest). Volume = USD wagered."
              : "Tower public weekly tournament leaderboard (tower.bet tournaments). Volume = USD wagered on the listed games.",
          started_at: iso(start * 1000),
          ends_at: iso(end * 1000),
          duration_seconds: end - start,
          snapshot_at: iso(now),
          leaderboard: contestRows(c.leaders, "rewards", true),
        }),
      );
    };
    push(lb, "contest");
    // Weekly provider tournament (recurring, 7 days). Optional: its failure doesn't fail the source.
    try {
      const t = await getJSON("https://tower.bet/api/race/type/tournament", "https://tower.bet/");
      const cur = isObj(t) ? arr(t.current).filter(isObj) : [];
      for (const c of cur) push(c, "tournament");
    } catch {
      /* monthly contest still counts as live */
    }
    if (!out.length) throw new Error("no running weekly/monthly race");
    return out;
  },
};

export const ADAPTERS: Adapter[] = [frogbet, jack, duckdice, tower];
