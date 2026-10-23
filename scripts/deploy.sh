#!/usr/bin/env bash
# Production deploy (`yarn deploy`): pushes migrations to the hosted Supabase project (after a dry
# run you confirm), sets Edge Function secrets, deploys the functions, then builds the iOS app on
# EAS and submits it to App Store Connect. `yarn deploy:local` (`--local`) builds the app on this
# Mac instead and uploads the .ipa with `eas submit`. `yarn deploy:backend` (`--backend`) stops
# after the Edge Functions and leaves the app alone.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "deploy: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

local_build=false
backend_only=false
case "${1:-}" in
  "") ;;
  --local) local_build=true ;;
  --backend) backend_only=true ;;
  *) fail "unknown option $1 (expected --local or --backend)." ;;
esac

env_file=supabase/functions/.env.production.local
[[ -f "$env_file" ]] || fail "$env_file is missing."

# Checked up front so a missing tool doesn't stop the deploy after the migrations are pushed.
if $local_build; then
  scripts/build-ios-local.sh --check
fi

step "Migrations (dry run)"
supabase db push --dry-run

read -r -p $'\nPush these migrations and continue? [y/N] ' answer
[[ "$answer" =~ ^[Yy]$ ]] || fail "Aborted."

step "Migrations"
supabase db push

step "Edge Function secrets"
supabase secrets set --env-file "$env_file"

step "Edge Functions"
supabase functions deploy

if $backend_only; then
  exit 0
elif $local_build; then
  step "iOS build (local)"
  scripts/build-ios-local.sh

  step "iOS submit"
  scripts/submit-ios.sh
else
  step "iOS build and submit"
  yarn dlx eas-cli build -p ios --profile production --auto-submit
fi
