#!/usr/bin/env bash
# Builds the production iOS app on this Mac (`yarn build:ios:local`) into build/ios.ipa, ready for
# `yarn submit:ios:local`. `--check` only checks the build can run, so `yarn deploy:local` can fail
# before it pushes migrations rather than after.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "build-ios-local: $*" >&2; exit 1; }

command -v fastlane >/dev/null || fail "fastlane is missing (brew install fastlane)."
# Local builds don't get the EAS secret, so the Sentry source map upload needs its own token.
[[ -n "${SENTRY_AUTH_TOKEN:-}" || -f ~/.sentryclirc ]] ||
  fail "No Sentry token: put it in ~/.sentryclirc or set SENTRY_AUTH_TOKEN."

[[ "${1:-}" == "--check" ]] && exit 0

ipa=build/ios.ipa
rm -f "$ipa"
yarn dlx eas-cli build -p ios --profile production --local --output "$ipa"
