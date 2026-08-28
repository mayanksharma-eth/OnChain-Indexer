# CoW Protocol Settlement Indexer — Implementation Report

## Architecture

CoW Protocol support is built as a **protocol adapter on top of the existing generic indexer**,
not a parallel system. The generic infrastructure — RPC client, block-range chunking/retries,
transactional persistence, confirmation-based finality, checkpointing, and bounded reorg
ancestor-finding — is reused as-is by both protocols.

The only change to previously-existing generic code is `handleReorg`
(`apps/indexer/src/reorg/reorg.ts`), which now takes its rollback function as an optional
parameter (defaulting to the intent protocol's `rollbackProjectionsFromBlock`, so the existing
demo is byte-for-byte unaffected). Every other change is new, additive files: a `cow-*.ts`
sibling next to each protocol-coupled file (decoder, projection, fetcher, pipeline, loop), plus a
second process entry point, `apps/indexer/src/index-cow.ts`.

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
CoW Protocol adapter  (apps/indexer/src/{decoder,projection}/cow-*.ts — the only
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

**Compatibility strategy**: both protocols run as independent processes against the same
chain/Postgres, checkpointed separately — `indexer_checkpoints` is keyed `(chainId, indexerName)`,
and the two streams use `"events"` (intent) and `"cow-events"` (CoW) respectively. This is exactly
the "run another process with different config" pattern the project's own multi-chain roadmap
already anticipated; no new orchestration concept was introduced.

**A real onchain subtlety drove one design decision**: verified against live mainnet logs (not
assumed) that `Settlement` is always emitted *after* `Trade` within one transaction. Since
`cow_trades` has an FK to `cow_settlements` on `(chainId, transactionHash)`, `cow-persist.ts`
persists each range in two passes — all `Settlement` events first, then everything else in
original order — rather than relying on strict log-index order.

## Official Sources Used

Verified directly from primary sources (raw `.sol` files fetched via `curl`/`grep`, not
paraphrased search summaries, which disagreed with each other on one point — see below):

- [cowprotocol/contracts — `GPv2Settlement.sol`](https://github.com/cowprotocol/contracts/blob/main/src/contracts/GPv2Settlement.sol) — exact event declarations for `Trade`, `Interaction`, `Settlement`, `OrderInvalidated`.
- [cowprotocol/contracts — `mixins/GPv2Signing.sol`](https://github.com/cowprotocol/contracts/blob/main/src/contracts/mixins/GPv2Signing.sol) — `PreSignature` event (inherited into `GPv2Settlement`; a websearch of docs.cow.fi mentioned it but an earlier `WebFetch` of the settlement contract missed it — resolved by `curl`-ing and `grep`-ing the raw source directly for `event `).
- [docs.cow.fi/cow-protocol/reference/contracts/core](https://docs.cow.fi/cow-protocol/reference/contracts/core) — deployment address `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`, confirmed identical across Ethereum, Gnosis Chain, Arbitrum, Base, and every other supported chain (deterministic factory deployment).
- [cowprotocol/contracts — `libraries/GPv2Order.sol`](https://github.com/cowprotocol/contracts/blob/main/src/contracts/libraries/GPv2Order.sol) — `orderUid` byte layout: `UID_LENGTH = 56`, packed as `orderDigest[32] ‖ owner[20] ‖ validTo[4]` (`packOrderUidParams`/`extractOrderUidParams`).
- Live `eth_getLogs` calls against `https://eth.drpc.org` (free, no API key) — used to (a) cross-check the locally-computed `keccak256` topic0 hashes against real onchain logs, (b) empirically confirm the `Trade`-before-`Settlement` emission order across 9 real transactions, and (c) pick and pre-verify the real validation block range.

## Events Indexed

| Event | Indexed? | Data extracted | Purpose |
|---|---|---|---|
| `Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)` | ✅ | owner, sellToken, buyToken, sellAmount, buyAmount, feeAmount, orderUid | The actual order execution — one row per order matched in a settlement batch. |
| `Settlement(address indexed solver)` | ✅ | solver | Which authorized solver executed the transaction. |
| `OrderInvalidated(address indexed owner, bytes orderUid)` | ✅ | owner, orderUid | Onchain order cancellation. |
| `Interaction(address indexed target, uint256 value, bytes4 selector)` | ❌ | — | Internal call-trace metadata, not order/solver data; would multiply row volume for no query value. |
| `PreSignature(address indexed owner, bytes orderUid, bool signed)` | ❌ | — | Offchain order pre-sign bookkeeping, not settlement execution. |

## Database Changes

Migration `packages/database/drizzle/0003_absurd_champions.sql`, generated via `drizzle-kit generate` from the schema:

| Table | Key | Indexes | Notes |
|---|---|---|---|
| `cow_settlements` | unique `(chain_id, transaction_hash)` | `(chain_id, solver, id)`, `(chain_id, block_number)` | One row per `settle()` call; unique on tx hash is also the FK target for `cow_trades`. |
| `cow_trades` | unique `(chain_id, transaction_hash, log_index)` | `(chain_id, owner, id)`, `(chain_id, order_uid, id)`, `(chain_id, transaction_hash)`, `(chain_id, block_number)` | FK `(chain_id, transaction_hash) → cow_settlements`. `sellAmount`/`buyAmount`/`feeAmount` are `numeric(78,0)` for full uint256 range. |
| `cow_order_events` | unique `(chain_id, transaction_hash, log_index)` | `(chain_id, order_uid, id)`, `(chain_id, owner, id)` | `OrderInvalidated` history; no FK to settlements (unrelated call). |

Raw decoded logs continue to flow through the existing, protocol-agnostic `events` table
(`(chain_id, transaction_hash, log_index)` unique) — the same idempotency guarantee holds
globally, not per-protocol. Reorg rollback for the CoW projection tables is a pure delete
(`deleteCowTradesFromBlock`/`deleteCowSettlementsFromBlock`/`deleteCowOrderEventsFromBlock`), since
unlike `intents` these rows are never mutated in place after insert.

## API

All new routes under the existing `/api/v1` prefix, Postgres-only, Zod-validated, cursor-paginated,
consistent `{ success, data, indexedBlock }` envelope (reading the CoW adapter's own
`cow-events` checkpoint, independent of the intent stream's):

| Endpoint | Example use case |
|---|---|
| `GET /api/v1/cow/settlements?solver=&fromBlock=&toBlock=&limit=&cursor=` | Recent settlements by a specific solver, or in a block range. |
| `GET /api/v1/cow/settlements/:transactionHash` | One settlement plus every trade executed in it. |
| `GET /api/v1/cow/trades?owner=&orderUid=&fromBlock=&toBlock=&limit=&cursor=` | Trades belonging to one owner, or in a block range. |
| `GET /api/v1/cow/trades/:orderUid` | Full onchain execution history for one order UID (partial fills across separate settlements show up as separate rows). |
| `GET /api/v1/cow/solvers/:address` | Paginated settlement list for one solver. |
| `GET /api/v1/cow/stats` | Total settlements, total trades, top 10 solvers by settlement count. Cache-aside, 2s TTL, invalidated after every persisted CoW range. |

`Fastify`'s default `maxParamLength` (100) was raised to 200 to accommodate the 114-character
`orderUid` path parameter.

## Real Validation

- **Chain**: Ethereum mainnet (chain ID 1)
- **Contract**: `GPv2Settlement`, `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`
- **Historical block range**: `21,000,000`–`21,000,030` — chosen by directly querying
  `eth_getLogs` against a free, no-API-key archive RPC (`eth.drpc.org`; most free RPCs, including
  the project's own `.env.example` default, only serve a recent-blocks window without a paid
  key) and confirming it deterministically contains real settlement activity, old enough to be
  permanently final so the test result never flakes.
- **Events indexed**: **9 `Settlement` events, 11 `Trade` events**, across 8 distinct blocks.
- **Example real row indexed**:
  ```
  tx 0x74d28c0eb71543b9adc6052e4ba0a61e3a8ba3af89eaf7a9ab72d7a970476469, block 21000001
    solver: 0x755BaE1cd46C9C27A3230AeF0CE923BDa13d29F7
    trade:  owner 0x61956c07e2499d10a36b01E73bdf56B97Efb63AD
            sold  26200000000000000000000 of 0xCb76314C2540199f4B844D4ebbC7998C604880cA
            for   1262930015180346460 of 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE (ETH sentinel)
  ```
- **Example API response** (from the actual test run):
  ```json
  {
    "success": true,
    "data": {
      "chainId": 1,
      "totalSettlements": 9,
      "totalTrades": 11,
      "topSolvers": [{ "solver": "0x008300082C3000009e63680088f8c7f4D3ff2E87", "settlementCount": 4 }, ...]
    },
    "indexedBlock": 21000030
  }
  ```
- **Reproduce it**:
  ```bash
  docker compose up -d postgres redis   # or a local Postgres/Redis
  pnpm db:migrate
  RUN_REAL_CHAIN_VALIDATION=1 pnpm vitest run tests/integration/cow-real-mainnet.test.ts
  ```
  This is a real RPC → real contract → real indexer → Postgres → CoW projection → Fastify API
  path end to end — no mocked chain, no fabricated events. It's gated behind an opt-in env var
  so the default `pnpm test` run has no network dependency.

## Tests

- **Total: 192** (152 pre-existing + 40 new), **all passing**. `typecheck`, `lint`, and `build`
  all pass cleanly across the whole monorepo.
- **New tests** (40):
  - CoW decoder (8) — correct decoding of all 3 events, address normalization, malformed/unknown
    log handling.
  - CoW repositories (12) — insert/idempotency, filtering, pagination, block-range filtering,
    solver ranking, reorg-rollback deletes, FK rejection on an unknown settlement.
  - CoW pipeline (3) — end-to-end persist including the Settlement-before-Trade FK ordering,
    duplicate-range idempotency, standalone `OrderInvalidated` events.
  - CoW reorg (1) — full fork/orphan/rollback/replay cycle against the CoW projection tables,
    proving the existing reorg mechanism (not a second implementation) handles CoW data
    correctly.
  - CoW API routes (15) — all 6 endpoints, filtering, pagination, validation errors, 404s,
    checkpoint isolation from the intent stream.
  - Real mainnet integration (1, opt-in) — see above.
- No existing test was weakened, removed, or had its assertions relaxed.

Commands run and their results:

```
pnpm typecheck   # PASS — all 6 workspace packages + tests/tsconfig.json
pnpm lint        # PASS — 0 errors (2 auto-fixed unnecessary-type-assertion lints in new test files)
pnpm build       # PASS — all packages/apps, including apps/indexer/dist/index-cow.js
pnpm test        # PASS — 191 passed, 1 skipped (real-chain test, opt-in)
RUN_REAL_CHAIN_VALIDATION=1 pnpm test   # PASS — 192 passed, 0 skipped
```

## Known Limitations

- **Onchain execution state only, not the offchain orderbook.** Order creation, quoting, and most
  cancellations happen offchain via CoW's API and are never emitted onchain — this indexer cannot
  see an order that was created and never settled.
- `orderUid` in `cow_trades`/`cow_order_events` is whatever the settling solver submitted as that
  field — not independently re-derived or verified against `GPv2Order.packOrderUidParams`.
- `Interaction` and `PreSignature` events are not indexed (see table above and README for
  rationale).
- Single-chain-per-process, same as the existing intent protocol — running CoW indexing on
  another chain means starting another `index-cow.ts` process with a different
  `CHAIN_ID`/`RPC_URL`, not orchestrated automatically.
- This remains, in the project's own words, **solver-oriented EVM indexing infrastructure** — not
  a claim of production-readiness at scale beyond what the existing Production Roadmap section
  already qualifies.

## Git Diff Summary

Nothing has been committed — this is the current working-tree diff for review.

**23 files changed** (399 insertions, 19 deletions) + **21 new files**.

Modified:
- `README.md` — new "CoW Protocol Adapter" section, updated Database Model / Query Layer /
  Repository Layout tables.
- `apps/indexer/src/reorg/reorg.ts` — `handleReorg` takes an optional rollback function.
- `apps/indexer/src/{decoder,fetcher,loop,pipeline,projection}/index.ts` — barrel exports for the
  new CoW modules.
- `apps/api/src/app.ts`, `lib/{cache,http,indexed-block,validation}.ts` — CoW route registration,
  `COW_INDEXER_NAME`, CoW cache keys/TTLs, `orderUid`/`txHash`/`blockNumber` validation schemas,
  raised `maxParamLength`.
- `apps/indexer/package.json`, root `package.json` — `dev:cow`/`start:cow` scripts.
- `packages/database/src/schema.ts` — 3 new tables + types.
- `packages/database/src/{cache,index}.ts`, `repositories/index.ts` — CoW cache
  keys/invalidation, CoW repository exports.
- `packages/database/src/repositories/test-setup.ts` — added CoW tables to the test truncation list.
- `packages/database/drizzle/meta/_journal.json` — new migration entry.
- `packages/abi/src/index.ts` — export the CoW ABI.
- `.env.example`, `docker-compose.yml` — CoW adapter documentation and an optional
  `cow-indexer` service (profile-gated, off by default).

New files (21): the CoW ABI (`packages/abi/src/cow.ts`), CoW decoder/events/processors/rollback/
event-processor, CoW fetcher/persist/pipeline/loop, `index-cow.ts` entry point, CoW repository
module, CoW API routes, the migration SQL + snapshot, and 6 new test files (decoder, repository,
pipeline, reorg, API routes, real-mainnet integration).
