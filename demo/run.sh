#!/usr/bin/env bash
# Demo fixture only — not part of the indexer/API product.
#
# Starts a local Anvil chain, deploys demo/contracts/src/Intent.sol, and emits an IntentCreated
# + IntentFilled pair (the contract also has cancelIntent, for a manual `cast send` if you want
# to see IntentCancelled/CANCELLED too). Prints the values to put in .env so the real
# indexer/API can index this chain. See demo/README.md.
set -euo pipefail

for bin in anvil forge cast; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "error: $bin not found — install Foundry: https://getfoundry.sh" >&2
    exit 1
  }
done

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/contracts" && pwd)"
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" # anvil default account #0
RPC_URL="http://127.0.0.1:8545"

echo "==> starting anvil (chain id 31337)"
anvil --silent &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
  cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "==> building + deploying Intent.sol"
FORGE_OUT=$(
  forge create "src/Intent.sol:Intent" \
    --root "$DEMO_DIR" \
    --rpc-url "$RPC_URL" \
    --private-key "$ANVIL_KEY" \
    --broadcast \
    --json
)
echo "$FORGE_OUT"
CONTRACT_ADDRESS=$(echo "$FORGE_OUT" | grep -o '"deployedTo": *"[^"]*"' | cut -d'"' -f4)
echo "==> deployed to $CONTRACT_ADDRESS"

INTENT_ID=$(cast keccak "demo-intent-1")
TOKEN_A="0x000000000000000000000000000000000000c0de"
TOKEN_B="0x000000000000000000000000000000000000beef"

echo "==> emitting IntentCreated"
cast send "$CONTRACT_ADDRESS" "createIntent(bytes32,address,address,uint256,uint256,uint256)" \
  "$INTENT_ID" "$TOKEN_A" "$TOKEN_B" 1000000000000000000 900000000000000000 9999999999 \
  --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" >/dev/null

echo "==> emitting IntentFilled"
cast send "$CONTRACT_ADDRESS" "fillIntent(bytes32,uint256,uint256)" \
  "$INTENT_ID" 1000000000000000000 950000000000000000 \
  --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" >/dev/null

cat <<EOF

==> done. Anvil is still running (pid $ANVIL_PID) — leave this terminal open.

Point the real indexer/API at this chain (in another terminal):

  cat > .env <<ENV
  DATABASE_URL=postgres://postgres:postgres@localhost:5433/indexer
  REDIS_URL=redis://localhost:6379
  RPC_URL=$RPC_URL
  CHAIN_ID=31337
  CONTRACT_ADDRESS=$CONTRACT_ADDRESS
  CONFIRMATIONS=0
  ENV

  docker compose up -d postgres redis
  pnpm db:migrate
  pnpm dev:indexer &   # separate terminal is fine too
  pnpm dev

Then verify:

  curl http://localhost:3000/api/v1/solver/state
  curl "http://localhost:3000/api/v1/intents?status=FILLED"

Ctrl+C this script to stop anvil when you're done.
EOF

wait "$ANVIL_PID"
