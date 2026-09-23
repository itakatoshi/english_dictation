#!/usr/bin/env bash
# ./run.sh test | check | zip | all
set -euo pipefail
cd "$(dirname "$0")"

run_test() {
  node --check lib.js content.js popup.js
  node --test test/*.test.js
  if node -e "require.resolve('jsdom')" 2>/dev/null; then
    node tools/dom-smoke.js
  else
    echo "(skip DOM smoke test: run 'npm install' to enable)"
  fi
}
run_check() { node tools/check-captions.mjs "$@"; }
run_zip() {
  version=$(node -p "require('./manifest.json').version")
  mkdir -p dist
  rm -f "dist/youtube-dictation-trainer-${version}.zip"
  python3 -m zipfile -c "dist/youtube-dictation-trainer-${version}.zip" manifest.json lib.js content.js content.css popup.html popup.css popup.js LICENSE
  echo "dist/youtube-dictation-trainer-${version}.zip"
}

case "${1:-all}" in
  test) run_test ;;
  check) shift; run_check "$@" ;;
  zip) run_zip ;;
  all) run_test; run_check; run_zip ;;
  *) echo "usage: $0 [test|check|zip|all]"; exit 2 ;;
esac
