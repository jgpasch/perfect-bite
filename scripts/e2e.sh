#!/usr/bin/env bash
# End-to-end tests (`yarn e2e [maestro test args]`): drives the debug build on the booted iOS
# simulator with Maestro, against local Supabase. Starts the Edge Functions (mock models) and Metro
# if they aren't running, and stops what it started on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "e2e: $*" >&2; exit 1; }

command -v maestro >/dev/null || fail "Maestro isn't installed (https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli)."
xcrun simctl list devices booted | grep -q Booted || fail "No iOS simulator is booted."
xcrun simctl listapps booted 2>/dev/null | grep -q '"com.jgp.perfectbite"' \
  || fail "The app isn't installed on the simulator. Run 'yarn expo run:ios' once."
supabase status >/dev/null 2>&1 || fail "Local Supabase isn't running. Run 'supabase start'."

pids=()
cleanup() { for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

if pgrep -f 'supabase functions serve' >/dev/null; then
  echo "e2e: Edge Functions are already being served; using them (their models may not be the mock)."
else
  supabase functions serve --env-file supabase/functions/.env.e2e >/tmp/perfect-bite-e2e-functions.log 2>&1 &
  pids+=($!)
fi

if lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "e2e: Metro is already running; using it."
else
  CI=1 yarn expo start --port 8081 >/tmp/perfect-bite-e2e-metro.log 2>&1 &
  pids+=($!)
  for _ in $(seq 60); do
    curl -sf http://127.0.0.1:8081/status >/dev/null && break
    sleep 1
  done
  curl -sf http://127.0.0.1:8081/status >/dev/null || fail "Metro didn't start (see /tmp/perfect-bite-e2e-metro.log)."
fi

maestro test "$@" .maestro
