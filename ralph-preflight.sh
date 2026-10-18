#!/bin/bash
# Run by ralph / ralph-parallel before each agent starts: make sure local
# Supabase is answering, so an agent never burns an iteration on Docker.
set -uo pipefail

orbctl start >/dev/null 2>&1 || { echo "preflight: orbctl start failed"; exit 1; }

for _ in {1..30}; do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || { echo "preflight: Docker didn't come up within 60s"; exit 1; }

if ! supabase status >/dev/null 2>&1; then
  echo "preflight: starting local Supabase…"
  supabase start >/dev/null || { echo "preflight: supabase start failed"; exit 1; }
fi
