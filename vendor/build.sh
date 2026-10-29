#!/bin/sh
# Rebuild public/vendor/ from the pinned packages in package.json.
# Barretenberg (local proof verification, ~16 MB) stays out: the browser only requests proofs, poidh's server verifies them.
set -e
cd "$(dirname "$0")"
bun install --frozen-lockfile 2>/dev/null || bun install
rm -rf ../public/vendor
bun build zkpassport.js --outdir ../public/vendor --splitting --minify --target browser \
  --external '@aztec/bb.js' --external '@aztec/bb.js-v4' --entry-naming '[name].[ext]' --chunk-naming 'zk-[hash].[ext]'
