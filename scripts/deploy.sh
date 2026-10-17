#!/usr/bin/env bash
# Production deploy (`yarn deploy`): pushes migrations to the hosted Supabase project (after a dry
# run you confirm), sets Edge Function secrets, deploys the functions, then builds the iOS app on
# EAS and submits it to App Store Connect.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "deploy: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

env_file=supabase/functions/.env.production.local
[[ -f "$env_file" ]] || fail "$env_file is missing."

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

step "iOS build and submit"
yarn dlx eas-cli build -p ios --profile production --auto-submit
