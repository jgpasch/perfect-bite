#!/usr/bin/env bash
# Uploads a locally built .ipa to App Store Connect for TestFlight (`yarn submit:ios:local [path]`).
# Defaults to build/ios.ipa, where `yarn build:ios:local` puts the build.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "submit-ios: $*" >&2; exit 1; }

ipa="${1:-build/ios.ipa}"
if [[ ! -f "$ipa" ]]; then
  others=$(ls -t ./*.ipa build/*.ipa 2>/dev/null || true)
  [[ -n "$others" ]] && fail "$ipa doesn't exist. Found: $(echo $others). Pass one: yarn submit:ios:local <path>"
  fail "$ipa doesn't exist. Build it first: yarn build:ios:local"
fi

yarn dlx eas-cli submit -p ios --profile production --path "$ipa"
