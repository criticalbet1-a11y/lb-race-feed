/**
 * Move a race the feed was already tracking into `finished` once, then leave it.
 * Finished leaderboards are not scraped again and are not replaced.
 *
 * A period is `source_id` + `id` + `ends_at`. The next week reuses `id`.
 */

export const FINISHED_CAP = 30;

/** FrogBet rounds the boundary to the nearest minute; allow that much slack. */
const PERIOD_GRACE_MS = 3 * 60 * 1000;

export interface RaceLike {
  id: string;
  source_id: string;
  started_at?: string;
  ends_at: string;
  leaderboard?: unknown;
  finished_at?: string;
}

export function periodKey(r: { source_id?: string; id?: string; ends_at?: string }): string {
  return `${r.source_id ?? ""}\0${r.id ?? ""}\0${r.ends_at ?? ""}`;
}

export function isEnded(endsAt: string, now: number): boolean {
  const t = Date.parse(endsAt);
  return Number.isFinite(t) && t <= now;
}

/**
 * True when `next` is the following period of the same race, not a corrected
 * window on the one still running. Overlapping dates (Halloween's stored end
 * was a Wednesday; the casino window runs through 31 Oct) are not successors.
 */
export function isSuccessor(prev: RaceLike, next: RaceLike): boolean {
  if (next.ends_at === prev.ends_at) return false;
  const prevEnd = Date.parse(prev.ends_at);
  const nextStart = Date.parse(next.started_at ?? "");
  if (!Number.isFinite(prevEnd) || !Number.isFinite(nextStart)) return false;
  return nextStart + PERIOD_GRACE_MS >= prevEnd;
}

/** Live rows plus any older not-yet-finished holding list, first copy wins. */
export function priorLive<T extends RaceLike>(races: readonly T[] | undefined, unfinished: readonly T[] | undefined): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const r of [...(races ?? []), ...(unfinished ?? [])]) {
    if (!r || typeof r.id !== "string" || typeof r.source_id !== "string" || typeof r.ends_at !== "string") continue;
    const key = periodKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export interface SplitOpts<T> {
  /** False when this row's endpoint was not queried this run (cadence skip or source failure). */
  fetched: (old: T) => boolean;
  /**
   * Casino confirmed a still-running row is gone (Tower weekly list refreshed and
   * this tournament is absent). Drop it. Do not invent a final before `ends_at`.
   */
  dropIfMissing?: (old: T) => boolean;
}

/**
 * `fresh === null` means this source was not fetched. An empty array means it
 * was fetched and returned nothing usable.
 */
export function splitPrev<T extends RaceLike>(prev: readonly T[], fresh: readonly T[] | null, now: number, opts: SplitOpts<T>): { live: T[]; archive: T[] } {
  const live: T[] = [];
  const archive: T[] = [];
  if (fresh) live.push(...fresh);
  const byId = new Map<string, T[]>();
  for (const r of fresh ?? []) {
    const list = byId.get(r.id);
    if (list) list.push(r);
    else byId.set(r.id, [r]);
  }
  const keys = new Set((fresh ?? []).map(periodKey));
  for (const old of prev) {
    if (fresh && keys.has(periodKey(old))) continue;
    const siblings = (byId.get(old.id) ?? []).filter((r) => r.ends_at !== old.ends_at);
    if (siblings.length) {
      if (siblings.some((r) => isSuccessor(old, r))) archive.push(old);
      continue;
    }
    if (isEnded(old.ends_at, now)) {
      archive.push(old);
      continue;
    }
    if (!opts.fetched(old)) {
      live.push(old);
      continue;
    }
    if (opts.dropIfMissing?.(old)) continue;
    live.push(old);
  }
  return { live, archive };
}

function frozenOk(r: RaceLike): boolean {
  return typeof r.finished_at === "string" && Number.isFinite(Date.parse(r.finished_at)) && Number.isFinite(Date.parse(r.ends_at)) && Array.isArray(r.leaderboard) && r.leaderboard.length > 0;
}

/**
 * Keep every already-finished period untouched (same object). Append newly
 * ended periods once. Newest `ends_at` first, capped.
 */
export function mergeFinished<T extends RaceLike>(
  prevFinished: readonly T[],
  newlyArchived: readonly T[],
  finishedAt: string,
  cap: number,
  sanitize: (r: T) => T | null,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const f of prevFinished) {
    if (!f || typeof f.id !== "string" || typeof f.ends_at !== "string" || !frozenOk(f)) continue;
    const key = periodKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  for (const r of newlyArchived) {
    const key = periodKey(r);
    if (seen.has(key)) continue;
    const clean = sanitize({ ...r, finished_at: finishedAt });
    if (!clean || !frozenOk(clean)) continue;
    const cleanKey = periodKey(clean);
    if (seen.has(cleanKey)) continue;
    seen.add(cleanKey);
    out.push(clean);
  }
  out.sort((a, b) => {
    const byEnd = Date.parse(b.ends_at) - Date.parse(a.ends_at);
    if (byEnd) return byEnd;
    const byFin = Date.parse(b.finished_at ?? "") - Date.parse(a.finished_at ?? "");
    if (byFin) return byFin;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out.slice(0, cap);
}
