#!/usr/bin/env bash
# Keep-alive scrape loop (GitHub's */10 schedule on this repo is unreliable).
# One run scrapes every 10 min for ~5h35m, then the workflow hands over to a
# fresh run (workflow_dispatch with GITHUB_TOKEN, which does start new runs).
# Per-source cadence and paid-proxy budgets stay in scrape.mjs (state.json).
set -u
INTERVAL=${LOOP_INTERVAL_S:-600}
BUDGET=${LOOP_BUDGET_S:-20100}   # 5h35m; job timeout is 350 min
start=$(date +%s)
publish() {
  local pub; pub=$(mktemp -d)
  cp data/races.json data/state.json "$pub"/ || return 1
  (
    cd "$pub" && git init -q -b data && git config user.name "race-feed-bot" &&
    git config user.email "race-feed-bot@users.noreply.github.com" &&
    git add races.json state.json && git commit -qm "feed $(date -u +%FT%TZ)" &&
    git push -qf "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data
  )
  local rc=$?; rm -rf "$pub"; return $rc
}
i=0
while :; do
  i=$((i + 1)); t0=$(date +%s)
  echo "::group::run $i $(date -u +%FT%TZ)"
  timeout 420 node --experimental-strip-types --no-warnings scrape.mjs data || echo "scrape failed (rc=$?)"
  if [ -s data/races.json ]; then publish && echo "published" || echo "publish failed"; fi
  echo "::endgroup::"
  # Next tick on the interval grid from the loop start; stop before the budget runs out.
  next=$(( start + i * INTERVAL ))
  now=$(date +%s)
  while [ "$next" -le "$now" ]; do i=$((i + 1)); next=$(( start + i * INTERVAL )); done
  if [ $(( next - start )) -ge "$BUDGET" ]; then echo "loop budget reached after $i ticks"; break; fi
  sleep $(( next - now ))
done
