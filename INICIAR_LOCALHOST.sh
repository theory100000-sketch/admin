#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  npm install
fi
( sleep 2; command -v xdg-open >/dev/null && xdg-open http://localhost:3000 >/dev/null 2>&1 || true ) &
node start-all.js
