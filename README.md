# Solver Indexer

A solver-oriented EVM indexing infrastructure with two things built on top of it:

1. **A generic indexer** (`apps/indexer`, `apps/api`, `packages/database`) — chunked backfill,
   confirmation-based finality, bounded reorg detection/rollback, transactional checkpointing,
   idempotent persistence, and a cache-backed Fastify API. Protocol-agnostic: it doesn't know
   what a "trade" or "intent" is, only how to fetch/decode/persist logs safely.
2. **Two protocol adapters** built on that infrastructure:
   - **Demo intent protocol** (`apps/indexer/src/index.ts`) — a toy `IntentCreated` /
     `IntentCancelled` / `IntentFilled` contract, used for the local Anvil demo below.
   - **CoW Protocol adapter** (`apps/indexer/src/index-cow.ts`) — a real integration against
     CoW Protocol's onchain settlement contract. See
     [CoW Protocol Adapter](#cow-protocol-adapter) below.

Each adapter runs as its own indexer process against the same generic infrastructure, and
checkpoints independently (`indexer_checkpoints` is keyed `(chainId, indexerName)`), so both can
run against the same chain/Postgres without colliding.

## Problem

A solver needs to answer questions like "which intents are open right now" or "has intent X been
filled" many times a second, filtered and paginated, without ever missing a fill or double-acting
on a cancelled intent. Direct RPC access can't do this:

- **No queries, only logs.** `eth_getLogs` returns raw, undecoded events for a block range — there
  is no "list open intents" or "has this intent been filled" call. Every solver would have to
  replay the entire event history itself, on every process, just to answer one question.
- **No historical state.** An RPC node gives you the state *now*. Reconstructing "what were the
  open intents as of block N" (or across a chain reorg) means re-deriving it from logs yourself,
  every time.
- **No aggregation.** Counting open intents, listing fills for an intent, or paginating a filtered
  intent list all require indexed, queryable storage — an RPC endpoint has no index to query.
- **Reorgs.** Logs from a re-orged block are simply gone from the next `eth_getLogs` response,
  with no signal that state derived from them (e.g. "intent X is FILLED") is now wrong. Something
  has to detect that and roll the derived state back.
- **Rate limits and latency.** Every solver re-deriving state from raw logs multiplies RPC load
  and adds the RPC's own latency to every decision a solver makes.

This project solves all of the above once, centrally: index the chain into Postgres, derive
correct domain state (with reorg handling), and let every solver read a fast, filtered,
paginated HTTP API instead of talking to the chain directly.

## Architecture

```mermaid
flowchart LR
    subgraph Chain
        RPC[EVM RPC Node]
    end

    subgraph Indexer Process
        Fetcher[Fetcher<br/>block ranges + logs]
        Decoder[Decoder<br/>ABI-decode logs]
        Pipeline[Pipeline<br/>transactional persist]
        Reorg[Reorg Handler]
        Checkpoint[Checkpoint Service]
    end

    subgraph Postgres
        Raw[(blocks / events<br/>immutable history)]
        Domain[(intents / fills<br/>domain state)]
        CP[(indexer_checkpoints)]
    end

    Redis[(Redis<br/>response cache)]

    subgraph API Process
        Fastify[Fastify HTTP API]
    end

    Solver[Solver]

    RPC --> Fetcher --> Decoder --> Pipeline
    Pipeline --> Raw
    Pipeline --> Domain
    Pipeline --> Checkpoint --> CP
    Reorg -. detects divergence via .-> RPC
    Reorg --> Raw
    Reorg --> Domain
    Reorg --> CP

    Fastify --> Raw
    Fastify --> Domain
    Fastify --> CP
    Fastify <--> Redis
    Solver -->|HTTP| Fastify
```

Two independent, stateless-except-for-Postgres processes:

- **`apps/indexer`** — a single long-running poll loop. Owns all writes. One process per chain.
- **`apps/api`** — a Fastify HTTP server. Read-only; never writes to Postgres. Stateless (can run
  multiple replicas behind a load balancer, since all shared state lives in Postgres/Redis).

They never talk to each other directly — Postgres (source of truth) and Redis (cache, optional)
are the only shared state between them.

## Data Flow

```
RPC → ingestion → decoding → persistence → domain projection → API → cache → solver
```

1. **RPC** (`apps/indexer/src/rpc`) — a thin wrapper over viem's `PublicClient`, retried with
   exponential backoff, validated against the configured `CHAIN_ID` at startup, and scoped to one
   `CONTRACT_ADDRESS` so `eth_getLogs` only ever returns that contract's logs.
2. **Ingestion** (`apps/indexer/src/fetcher`) — splits `[startBlock, safeBlock]` into fixed-size
   chunks, fetches each chunk's logs plus the block metadata those logs reference.
3. **Decoding** (`apps/indexer/src/decoder`) — ABI-decodes each log against the intent protocol
   ABI (`packages/abi`). Logs that don't match a known event are dropped, not errored — a chain
   can emit plenty of logs the indexer doesn't care about.
4. **Persistence** (`apps/indexer/src/pipeline`) — every block and decoded event in one chunk is
   written to Postgres in a **single transaction**, alongside its domain projection and the
   checkpoint advance. See [Indexing Strategy](#indexing-strategy).
5. **Domain projection** (`apps/indexer/src/projection`) — turns raw decoded events into
   `intents`/`fills` rows with a validated state machine (`OPEN → CANCELLED | FILLED`).
6. **API** (`apps/api`) — Fastify routes read `intents`/`fills`/`indexer_checkpoints` directly.
   Every response reports the checkpointed block it reflects.
7. **Cache** (`apps/api/src/lib/cache.ts`, `packages/database/src/cache.ts`) — a short-TTL
   Redis read-through in front of the hottest routes. Optional; every route works without it.
8. **Solver** — polls `GET /api/v1/solver/state` and `GET /api/v1/intents?status=OPEN` instead of
   talking to the chain.

## Database Model

| Table                 | Purpose                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chains`               | One row per indexed chain (`chain_id`, display `name`). `latest_block`/`indexed_block` mirror the live checkpoint for quick multi-chain listing; `indexer_checkpoints` is the value the indexer actually resumes from. |
| `blocks`                | Every block the indexer has touched, keyed `(chain_id, block_number, block_hash)`. `is_canonical` flips to `false` when a reorg orphans it — rows are never deleted for blocks, only relabeled. A partial unique index enforces at most one canonical block per height. |
| `events`               | Immutable append-only log of every decoded event, keyed `(chain_id, transaction_hash, log_index)`. Never mutated except `is_canonical`, which a reorg flips the same way as `blocks`. This is the audit trail domain state is derived from. |
| `intents`               | Current derived state per intent (`OPEN`/`CANCELLED`/`FILLED`), one row per `(chain_id, intent_id)`. Amounts are `numeric(78,0)` to hold a full uint256 without precision loss. Rewritten in place as new events arrive — this is a materialized view of `events`, not independent history. |
| `fills`                 | One row per `IntentFilled` event, keyed `(chain_id, transaction_hash, log_index)`. A `fills.intent_id` foreign key ties it to its intent. |
| `indexer_checkpoints`   | One row per `(chain_id, indexer_name)`: the last block number + hash successfully committed. The single source of truth for where indexing resumes and how far reorg detection compares against. |
| `cow_settlements`      | CoW adapter: one row per `Settlement` event (one per `settle()` call), keyed `(chain_id, transaction_hash)`. Records which solver executed the transaction. |
| `cow_trades`           | CoW adapter: one row per `Trade` event (one per order matched in a settlement's batch), keyed `(chain_id, transaction_hash, log_index)`, FK to `cow_settlements`. |
| `cow_order_events`     | CoW adapter: one row per `OrderInvalidated` event (an onchain order cancellation), keyed `(chain_id, transaction_hash, log_index)`. |

`blocks`/`events` are the immutable raw layer; `intents`/`fills` (demo protocol) and
`cow_settlements`/`cow_trades`/`cow_order_events` (CoW adapter) are the queryable domain layers
derived from it. A reorg rewinds every layer together, in one transaction — see
[Reorg Strategy](#reorg-strategy).

## Indexing Strategy

- **Chunking** (`apps/indexer/src/fetcher/ranges.ts`) — `[startBlock, safeBlock]` is split into
  fixed-size (`INDEXER_CHUNK_SIZE`) ranges, fetched and persisted one at a time, in order. This
  bounds both the `eth_getLogs` window (RPC providers cap range size) and the size of each
  transaction.
- **Checkpointing** (`apps/indexer/src/checkpoint`) — `indexer_checkpoints` records the last
  block number *and hash* successfully committed. The checkpoint only ever advances inside the
  same transaction as that range's block/event/domain writes (`pipeline/persist.ts`) — a range
  that fails partway rolls everything in it back, checkpoint included, so the checkpoint never
  points past data that isn't actually there.
- **Retries** — two layers: the RPC client retries individual failed calls with exponential
  backoff (`rpc/retry.ts`), and the fetcher retries a whole range as a unit on top of that
  (`fetcher/fetcher.ts`). A range that still fails after retries throws and stops the poll cycle;
  the next poll interval retries from the last committed checkpoint — nothing is skipped.
- **Idempotency** — every insert (`blocks`, `events`, `intents`, `fills`) uses
  `onConflictDoNothing`/status-aware upserts, and every domain transition checks current state
  before applying. Re-processing an already-indexed range (a restart with no new checkpoint, a
  retried range, a replayed reorg range) is always a safe no-op, never a duplicate row or a
  corrupted transition. See `apps/indexer/src/projection/README.md` for the full state-transition
  table.

## Reorg Strategy

Every poll cycle, before indexing anything new, the indexer re-fetches the block at its last
checkpointed height and compares its hash to what's stored locally. A mismatch means the chain
reorganized underneath the last checkpoint.

1. **Find the common ancestor** (`apps/indexer/src/reorg/reorg.ts`) — walk backward from the
   divergent height, comparing the chain's current view of each block against what's stored
   locally as canonical, until they agree (or a height has no local record — nothing to
   disagree with). Bounded by `MAX_REORG_DEPTH` (20 blocks); a deeper reorg raises
   `ReorgTooDeepError` and halts indexing rather than silently doing the wrong thing.
2. **Rollback, in one transaction** — every `blocks`/`events` row at or above the ancestor is
   marked `is_canonical = false` (never deleted — they stay as audit trail), the domain
   projections derived from those events are undone (`projection/rollback.ts`: fills from the
   reorged range deleted, intents created there deleted, intents merely updated there reopened
   to `OPEN`), and the checkpoint is restored to the ancestor.
3. **Replay** — re-fetching and re-indexing the new canonical chain from the restored checkpoint
   is just the next normal indexing pass (`runIndexingPipeline`). No separate replay machinery.

## Finality

`CONFIRMATIONS` (default 5) defines the **safe block**: `chainHead - CONFIRMATIONS`. The indexer
never processes past it — `safeBlock = latestBlock - CONFIRMATIONS`, and every chunked range is
capped there. This is a probabilistic-finality guard on top of the reorg handling above: it
keeps ordinary small reorgs from ever being observed as indexed data in the first place, so the
(bounded, but non-zero-cost) rollback path in [Reorg Strategy](#reorg-strategy) is only needed for
reorgs deeper than `CONFIRMATIONS`.

## Query Layer

All routes are prefixed `/api/v1` and return a consistent envelope:

```json
{ "success": true, "data": ..., "indexedBlock": 21000000 }
```

`indexedBlock` is read from `indexer_checkpoints` **before** the query it accompanies runs, so it
never claims freshness the returned rows don't actually have (see
`apps/api/src/lib/indexed-block.ts`). Errors use `{ "success": false, "error": { "message", "code" } }`.

| Method & Path                          | Description                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/v1/health`                    | Liveness — process is up. No dependency checks.                                    |
| `GET /api/v1/ready`                     | Readiness — Postgres reachable, Redis reachable (if configured), app bootstrapped. `503` if not. |
| `GET /api/v1/indexer/status`            | Checkpointed block/hash/updatedAt for the configured chain.                        |
| `GET /api/v1/intents`                   | Paginated, filterable intent list. Query: `status`, `owner`, `tokenIn`, `tokenOut`, `limit` (≤100, default 20), `cursor`. |
| `GET /api/v1/intents/:intentId`         | Single intent by id. `404` if unknown.                                             |
| `GET /api/v1/intents/:intentId/fills`   | Fills for one intent, oldest first.                                                |
| `GET /api/v1/addresses/:address/intents`| Intents owned by an address (same filters/pagination as `/intents` minus `owner`). |
| `GET /api/v1/solver/state`              | Aggregate counts: open/filled/cancelled intents, total fills.                      |
| `GET /api/v1/cow/settlements`           | Paginated settlement list. Query: `solver`, `fromBlock`, `toBlock`, `limit`, `cursor`. `indexedBlock` here reads the CoW adapter's own checkpoint (`cow-events`), independent of the intent stream's. |
| `GET /api/v1/cow/settlements/:transactionHash` | One settlement plus the trades executed in it. `404` if unknown. |
| `GET /api/v1/cow/trades`                | Paginated trade list. Query: `owner`, `orderUid`, `fromBlock`, `toBlock`, `limit`, `cursor`. |
| `GET /api/v1/cow/trades/:orderUid`      | Execution history for one order UID — every trade that matched it, oldest first (partial fills across separate settlements show up as separate rows). |
| `GET /api/v1/cow/solvers/:address`      | Paginated settlement list for one solver (same shape as `/cow/settlements?solver=`). |
| `GET /api/v1/cow/stats`                 | Aggregate counts: total settlements, total trades, top 10 solvers by settlement count. Cached (2s TTL). |
| `GET /metrics`                          | Prometheus metrics (unprefixed — not under `/api/v1`).                             |

### Examples

```bash
curl http://localhost:3000/api/v1/indexer/status
# {"success":true,"data":{"chainId":1,"indexerName":"events","indexedBlock":21000042,
#   "indexedBlockHash":"0x...","updatedAt":"2026-08-27T12:00:00.000Z"},"indexedBlock":21000042}

curl "http://localhost:3000/api/v1/intents?status=OPEN"
# {"success":true,"data":[{"id":1,"intentId":"0x...","owner":"0x...","tokenIn":"0x...",
#   "tokenOut":"0x...","amountIn":"1000000000000000000","minAmountOut":"900000000000000000",
#   "status":"OPEN", ...}],"indexedBlock":21000042,"nextCursor":null}

curl http://localhost:3000/api/v1/solver/state
# {"success":true,"data":{"chainId":1,"openIntents":12,"filledIntents":340,
#   "cancelledIntents":8,"totalFills":340},"indexedBlock":21000042}
```

## Solver Integration

A solver's simplest integration is a poll loop against `GET /api/v1/solver/state` for a fast
health/volume check, and `GET /api/v1/intents?status=OPEN` for the actual work queue:

```ts
async function pollSolverState(apiUrl: string) {
  const res = await fetch(`${apiUrl}/api/v1/solver/state`);
  const { data, indexedBlock } = await res.json();
  console.log(`chain ${data.chainId}: ${data.openIntents} open intents as of block ${indexedBlock}`);
  return data;
}
```

Every response carries `indexedBlock`, so a solver can detect staleness (e.g. compare it to its
own view of chain head) without a second call. Pagination on `/intents` is cursor-based
(`nextCursor` from one page is the `cursor` for the next) and stable under concurrent inserts —
see `intents_chain_status_idx` in the schema.

## Caching

Redis sits in front of the three hottest read routes (`solver/state`, `intents?status=OPEN`,
`indexer/status`) as a cache-aside layer with a 1–2 second TTL, invalidated proactively after
every successfully persisted range (`invalidateChainCache` in the indexer loop). **Postgres
remains the source of truth in every case**:

- A cache miss, a Redis error, or Redis being unconfigured all fall through to Postgres
  identically — `packages/database/src/cache.ts`'s `cached()` never treats Redis as required.
- A failed cache *write* is swallowed, never fails the request.
- The TTL is a hard upper bound on staleness even if invalidation is ever missed — nothing is
  served more than 1–2 seconds stale.

Redis is entirely optional (`REDIS_URL` unset ⇒ every route just always reads Postgres directly).

## Failure Modes

| Failure                    | Behavior                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPC fails**                | Individual calls retry with exponential backoff (`rpc/retry.ts`); a whole failed range retries on top of that (`fetcher.ts`). Exhausting retries fails the poll cycle — logged, checkpoint untouched, retried next `INDEXER_POLL_INTERVAL_MS`. |
| **DB fails**                 | A failed transaction rolls back entirely (nothing partial persists). The indexer logs and retries next poll. The API's `/ready` reports `503` immediately (checked with a 2s timeout); already-cached reads keep serving from Redis until their TTL expires. |
| **Redis fails**              | Every cache read/write failure is caught and treated as a miss/no-op (see [Caching](#caching)) — reads fall through to Postgres, writes are best-effort. `/ready` reports Redis's status but only fails the readiness check, not any individual data route. |
| **Process crashes**          | On restart, the indexer resumes from the last committed `indexer_checkpoints` row (see [Indexing Strategy](#indexing-strategy)) — no replay machinery needed, no double-processing (idempotent writes) or gaps (checkpoint only advances after a successful commit). |
| **Reorg occurs**             | Detected at the top of the next poll cycle (checkpointed block's hash no longer matches chain), handled per [Reorg Strategy](#reorg-strategy). Deeper than `MAX_REORG_DEPTH` (20 blocks) halts indexing with `ReorgTooDeepError` rather than guessing. |

## Testing

Every module has focused unit/integration tests next to its source (`*.test.ts`), run against a
real Postgres/Redis (not mocked) via `pnpm test` — see [Local Development](#local-development).
Notably:

- `apps/indexer/src/reorg/reorg.test.ts` — a scripted fork-and-replace scenario asserting the
  orphaned block/event/intent state and the restored checkpoint.
- `apps/indexer/src/pipeline/pipeline.test.ts` — transactional atomicity: a failing write inside
  a range leaves no partial state and no checkpoint advance.
- `apps/api/src/routes/cache.test.ts` — cache hit/miss/expiry/invalidation and Redis-down
  fallback, exercised through a real route, not just the cache helper in isolation.
- `tests/integration/end-to-end.test.ts` — the full stack: a scripted mock chain drives the real
  indexer loop (backfill, checkpoint resume across a simulated restart, an injected transient RPC
  failure, a chain reorg) against real Postgres, with the real Fastify app reading results back
  over HTTP the whole time — and Redis deliberately broken throughout, proving every route
  degrades to Postgres correctly.

## Local Development

```bash
cp .env.example .env        # fill in RPC_URL / CONTRACT_ADDRESS for real indexing
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev            # apps/api, watch mode
pnpm dev:indexer     # apps/indexer, watch mode (separate terminal)
```

Run the checks:

```bash
pnpm test        # vitest — needs postgres/redis running (docker compose up -d postgres redis)
pnpm typecheck
pnpm lint
pnpm build
```

### Demo: real chain, real events

`tests/integration` exercises the indexer against a scripted mock chain. To see it index a real
chain instead — a real Anvil node, a real deployed contract, real `IntentCreated`/`IntentFilled`
transactions — run:

```bash
./demo/run.sh
```

It prints the exact `.env` values and `pnpm` commands to point the indexer/API above at it. See
[demo/README.md](demo/README.md) — that directory is a fixture for driving this demo, not part
of the indexer/API product.

Or run the whole stack in containers:

```bash
cp .env.example .env
docker compose up --build
```

This builds `apps/api` and `apps/indexer` images, runs migrations once (`migrate` service), then
starts Postgres, Redis, the indexer, and the API (`http://localhost:3000`).

## CoW Protocol Adapter

A real protocol integration on top of the generic infrastructure above, not a second copy of it.

```
Ethereum (or any chain CoW Protocol is deployed to)
    │
    ▼
CoW Protocol's GPv2Settlement contract (0x9008D19f58AAbD9eD0D60971565AA8510560ab41 — the same
    │                                    deterministic address on every supported chain)
    ▼
Trade / Settlement / OrderInvalidated events
    │
    ▼
Generic EVM indexer  (apps/indexer/src/{fetcher,pipeline,reorg,checkpoint} — unmodified,
    │                  shared with the demo intent protocol)
    ▼
CoW Protocol adapter  (apps/indexer/src/{decoder,projection}/cow-*.ts — this is the only
    │                   protocol-specific code)
    ▼
PostgreSQL  (cow_settlements / cow_trades / cow_order_events)
    │
    ▼
REST API  (GET /api/v1/cow/*)
    │
    ▼
Solver / analytics consumer
```

### What's indexed, and why

Verified against the contract source directly (`GPv2Settlement.sol` + its `GPv2Signing` mixin on
[cowprotocol/contracts](https://github.com/cowprotocol/contracts), cross-checked against
[docs.cow.fi](https://docs.cow.fi/cow-protocol/reference/contracts/core)), not guessed:

| Event | Indexed? | Why |
| --- | --- | --- |
| `Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)` | ✅ | The actual order execution — sell/buy tokens and amounts for one matched order. |
| `Settlement(address indexed solver)` | ✅ | Which authorized solver executed the batch. |
| `OrderInvalidated(address indexed owner, bytes orderUid)` | ✅ | An onchain order cancellation. |
| `Interaction(address indexed target, uint256 value, bytes4 selector)` | ❌ | Internal call-trace metadata (an arbitrary external call the settlement made), not order or solver data — indexing it would multiply row volume for no query value. |
| `PreSignature(address indexed owner, bytes orderUid, bool signed)` | ❌ | Offchain order pre-sign bookkeeping, not settlement execution. |

`GPv2Settlement` is deployed at the same address on Ethereum mainnet, Gnosis Chain, Arbitrum,
Base, and every other chain CoW Protocol supports — point `CONTRACT_ADDRESS` at it with the
matching `CHAIN_ID`/`RPC_URL` and the adapter works unchanged on any of them.

**Order UID**: CoW's 56-byte packed `orderUid` (`orderDigest[32] || owner[20] || validTo[4]`, per
`GPv2Order.packOrderUidParams`) is stored as a `0x`-prefixed 112-hex-char string, unmodified from
the event data.

### Onchain execution state, not the offchain orderbook

**This indexes the onchain settlement layer only.** Be precise about what that does and doesn't
mean:

- ✅ Which solver executed which settlement transaction, when.
- ✅ Which orders were actually matched/filled onchain, at what price, in which transaction.
- ✅ Onchain order cancellations (`OrderInvalidated`).
- ✅ Partial-fill history for one order UID, if the parts were filled in separate settlements
  (each shows up as its own `cow_trades` row).
- ❌ **Not** the offchain CoW orderbook. Order creation, quoting, and most cancellations happen
  offchain via CoW's API and are never emitted onchain — this indexer cannot see an order that
  was created and never settled.
- ❌ **Not** a guarantee that `orderUid` fully identifies "one order" the way `intents.intent_id`
  does for the demo protocol — it's whatever the settling solver submitted as that field.

### Why this fits the existing architecture without changing it

The generic pieces (RPC client, block-range chunking/retries, checkpointing, confirmation-based
finality, reorg ancestor-finding) are reused as-is — see `apps/indexer/src/pipeline/cow-*.ts` and
`apps/indexer/src/fetcher/cow-fetcher.ts`, which are structurally identical to their intent-protocol
counterparts but decode/project against the CoW ABI instead. The one shared function that
previously hardcoded the intent protocol's rollback (`handleReorg` in `apps/indexer/src/reorg/reorg.ts`)
now takes the rollback function as a parameter (defaulting to the intent protocol's, so the demo
is unaffected) — that's the only change to previously-existing generic code. Everything else CoW
adds is new files.

Run it as a **second, independent indexer process** against the same chain/Postgres — the schema
was already `(chainId, indexerName)`-scoped for exactly this:

```bash
# same DATABASE_URL/REDIS_URL/RPC_URL/CHAIN_ID as the main indexer
CONTRACT_ADDRESS=0x9008D19f58AAbD9eD0D60971565AA8510560ab41 pnpm dev:indexer:cow
```

or in Docker: `docker compose --profile cow up cow-indexer` once `COW_CONTRACT_ADDRESS` (and
optionally `COW_START_BLOCK`) are set in `.env` (see `.env.example`).

### Real CoW mainnet validation

No mocked RPC, no fabricated events — indexing a real, already-final block range straight from a
real Ethereum node:

```bash
docker compose up -d postgres redis   # or use a local Postgres/Redis
pnpm db:migrate
RUN_REAL_CHAIN_VALIDATION=1 pnpm vitest run tests/integration/cow-real-mainnet.test.ts
```

This connects to a free, no-API-key archive RPC (`eth.drpc.org` — most free RPCs, including
`eth.llamarpc.com` in `.env.example`, only serve a recent-blocks window without a paid key) and
indexes **Ethereum mainnet blocks 21,000,000–21,000,030**. That range was picked by directly
querying `eth_getLogs` against the real `GPv2Settlement` contract before writing the test and
confirming it deterministically contains **9 `Settlement` events and 11 `Trade` events across 8
blocks** — old enough to be permanently final, so the assertion never flakes. The test then reads
the result back through the real Fastify API (`GET /api/v1/cow/stats`,
`GET /api/v1/cow/settlements`), not just the repository layer.

Example of what actually got indexed from that run:

```
tx 0x74d28c0eb71543b9adc6052e4ba0a61e3a8ba3af89eaf7a9ab72d7a970476469, block 21000001
  solver: 0x755BaE1cd46C9C27A3230AeF0CE923BDa13d29F7
  trade:  owner 0x61956c07e2499d10a36b01E73bdf56B97Efb63AD
          sold  26200000000000000000000 of 0xCb76314C2540199f4B844D4ebbC7998C604880cA
          for   1262930015180346460 of 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE (ETH sentinel)
```

```bash
curl http://localhost:3000/api/v1/cow/stats
# {"success":true,"data":{"chainId":1,"totalSettlements":9,"totalTrades":11,
#   "topSolvers":[{"solver":"0x008300082C3000009e63680088f8c7f4D3ff2E87","settlementCount":4}, ...]},
#  "indexedBlock":21000030}

curl "http://localhost:3000/api/v1/cow/settlements?fromBlock=21000000&toBlock=21000030"
curl "http://localhost:3000/api/v1/cow/trades/0x0490b9003934d4ca6fe4b65fc54b45152622d41b06a2b6b07e6b9f1e1ecf8f7761956c07e2499d10a36b01e73bdf56b97efb63ad6713beea"
```

To index a different (or larger) range, edit `START_BLOCK`/`END_BLOCK` in that test file, or set
`COW_VALIDATION_RPC_URL` to point at your own archive RPC.

### Limitations specific to this adapter

- Reads what's onchain only — see [Onchain execution state, not the offchain orderbook](#onchain-execution-state-not-the-offchain-orderbook) above.
- `Interaction`/`PreSignature` events are not indexed (see table above) — a future consumer
  needing them would extend `packages/abi/src/cow.ts` and the CoW decoder/projection files, not
  the generic infrastructure.
- No cross-chain aggregation — each chain's data is `chainId`-scoped, same as the rest of this
  project; running CoW indexing on more than one chain is "run another `index-cow.ts` process
  with a different `CHAIN_ID`/`RPC_URL`," same caveat as the existing multi-chain roadmap item
  below.

## Production Roadmap

**Implemented today:** single-chain indexing with chunked backfill + poll-forever sync,
transactional persistence, confirmation-based finality, bounded reorg detection/rollback,
checkpoint-based crash recovery, a cache-aside Redis layer that's fully optional, a paginated
solver-facing HTTP API, Prometheus metrics (`/metrics`), and structured JSON logging.

**Not implemented — this is a single-instance, single-chain, single-RPC-provider system.** Before
calling it production-ready at real scale, the following are the natural next steps and are
**not** currently built:

- **Multiple RPC providers** — automatic failover/load-balancing across providers; today a single
  `RPC_URL` is a single point of failure for ingestion.
- **WebSockets** — subscribing to new heads/logs instead of polling every `INDEXER_POLL_INTERVAL_MS`
  would cut latency and RPC call volume.
- **Kafka/event streaming** — decoupling ingestion from persistence via a durable event log, so
  the indexer and downstream consumers don't share one process/transaction boundary.
- **ClickHouse** (or similar OLAP store) — for historical analytics/aggregation queries at a scale
  Postgres row-store isn't the right tool for.
- **PostgreSQL partitioning** — `events`/`blocks` will grow unbounded; partitioning by block range
  or time is the standard mitigation once volume matters.
- **Read replicas** — the API is already stateless and horizontally scalable, but currently reads
  from the same Postgres primary the indexer writes to.
- **Horizontal indexer workers** — the indexer is single-instance per chain today (no leader
  election or partitioned work); running more than one against the same `(chainId, indexerName)`
  checkpoint would race.
- **Multi-chain indexing** — the schema and repositories are already `chainId`-scoped throughout,
  but only one indexer process (one chain, one contract) is wired up today; running more is
  "start another process with different config," not yet orchestrated.
- **Advanced finality** — e.g. consuming a beacon-chain finalized-checkpoint feed instead of a
  fixed confirmation count.
- **Prometheus/Grafana** — metrics are exported (`/metrics`) but no scrape config, dashboards, or
  alerting rules are included.

## Repository Layout

```
apps/
  indexer/    # rpc -> fetcher -> decoder -> pipeline -> reorg -> checkpoint (generic, protocol-agnostic)
    src/index.ts       # demo intent protocol entry point
    src/index-cow.ts   # CoW Protocol adapter entry point (run as a separate process)
    src/{decoder,projection,fetcher,pipeline}/cow-*.ts  # the CoW-specific adapter code
  api/        # Fastify HTTP API (read-only) — /api/v1/intents/* (demo), /api/v1/cow/* (CoW)
packages/
  config/     # env loading + validation (zod) — shared by both protocols, no protocol-specific vars
  database/   # Postgres (drizzle) schema, migrations, repositories, Redis cache-aside
  abi/        # contract ABIs (viem) — intent.ts (demo), cow.ts (verified CoW GPv2Settlement ABI)
  utils/      # logger, Prometheus metrics
tests/        # cross-app integration tests: a scripted mock chain (demo protocol), and a real
              # Ethereum mainnet run against CoW Protocol (cow-real-mainnet.test.ts)
demo/         # demo fixture only — real Anvil chain + contract to drive an E2E run, see demo/README.md
```
