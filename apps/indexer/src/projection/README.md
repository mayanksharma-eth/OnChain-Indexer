# Domain state projection

Transforms decoded chain events into normalized intent/fill state. The `events` table is
immutable history (every decoded log, as-is); `intents`/`fills` are the current queryable
domain state, derived from it by the processors in this directory.

## Lifecycle

```
        IntentCreated
             │
             ▼
           OPEN ──────────────┐
        │       │             │
IntentCancelled │   IntentFilled
        ▼       │             ▼
    CANCELLED   │          FILLED
             (terminal)  (terminal)
```

| Event             | Precondition   | Effect                                  |
| ----------------- | -------------- | ---------------------------------------- |
| `IntentCreated`   | intent absent  | create intent, status `OPEN`             |
| `IntentCancelled` | status `OPEN`  | status → `CANCELLED`                     |
| `IntentFilled`    | status `OPEN`  | create fill, status → `FILLED`           |

`CANCELLED` and `FILLED` are terminal — no event moves an intent out of either.

## Idempotency

Every processor is safe to re-run with the same event (e.g. re-persisting a block range after a
restart with no checkpoint saved yet):

- `IntentCreated` replayed → returns the existing intent, no duplicate row.
- `IntentCancelled` replayed on an already-`CANCELLED` intent → no-op, returns the existing intent.
- `IntentFilled` replayed with the same `(transactionHash, logIndex)` on an already-`FILLED`
  intent → no-op, returns the existing intent and fill.

## Rejected as errors (`ProjectionError`)

- The referenced intent doesn't exist yet — an `IntentCancelled`/`IntentFilled` arrived before
  its `IntentCreated`. Signals events were applied out of causal order.
- An invalid transition: cancelling a `FILLED` intent, filling a `CANCELLED` intent, or applying
  a second, *different* fill to an already-`FILLED` intent.

These throw rather than silently mutating state, so the surrounding transaction (see
`pipeline/persist.ts`) rolls back instead of committing corrupted domain state.

## Unknown events

`EventProcessor` (`event-processor.ts`) dispatches on `eventName`. Any decoded event outside the
three known intent events is ignored — it's still written to the immutable `events` table by the
caller, just not projected into `intents`/`fills`.
