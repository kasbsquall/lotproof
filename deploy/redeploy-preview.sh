#!/usr/bin/env bash
# This file is part of Lotproof.
# SPDX-License-Identifier: Apache-2.0
#
# Redeploy the demo contract on Midnight Preview, for when the network is reset
# and the old contract address no longer exists. The demo service deploys a new
# contract, registers the station and publishes the drawing spec on start
# whenever its state file has no contract address.
#
# The previous state file is kept as demo-state.preview.<timestamp>.json inside
# the data volume. Run from deploy/:  ./redeploy-preview.sh
set -euo pipefail
cd "$(dirname "$0")"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T app sh -c \
  "test -f data/demo-state.preview.json && mv data/demo-state.preview.json data/demo-state.preview.$stamp.json || true"
docker compose restart app

echo "Waiting for the new contract (wallet sync, deploy, station and spec take a few minutes)..."
for _ in $(seq 1 120); do
  health=$(curl -s -m 5 http://127.0.0.1:8787/api/health || true)
  if echo "$health" | grep -q '"ready":true'; then
    echo "$health"
    exit 0
  fi
  sleep 5
done
echo "The service did not become ready in 10 minutes. Check: docker compose logs app" >&2
exit 1
