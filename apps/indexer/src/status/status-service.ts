export type IndexerState =
  | "STARTING"
  | "BACKFILLING"
  | "SYNCING"
  | "CAUGHT_UP"
  | "REORGING"
  | "ERROR"
  | "STOPPED";

export interface IndexerStatusSnapshot {
  chainId: number;
  state: IndexerState;
  chainHead: number | null;
  safeBlock: number | null;
  indexedBlock: number | null;
  lag: number | null;
  eventsIndexed: number;
  intentsIndexed: number;
  fillsIndexed: number;
  lastSuccessfulIndexAt: string | null;
  lastError: { message: string; at: string } | null;
}

/**
 * In-memory lifecycle + progress tracker for one indexer process. One instance per running
 * indexer (single chain per process, see loop/loop.ts) — not for cross-process sharing. Exposed
 * as a snapshot so a future API layer can read it (e.g. a /status route reading the same
 * process's instance) without depending on this class's internals.
 */
export class IndexerStatusService {
  private chainId = 0;
  private state: IndexerState = "STARTING";
  private chainHead: number | null = null;
  private safeBlock: number | null = null;
  private indexedBlock: number | null = null;
  private eventsIndexed = 0;
  private intentsIndexed = 0;
  private fillsIndexed = 0;
  private lastSuccessfulIndexAt: string | null = null;
  private lastError: { message: string; at: string } | null = null;

  /** Resets to a fresh STARTING state for the given chain — call once when a loop begins. */
  start(chainId: number): void {
    this.chainId = chainId;
    this.state = "STARTING";
    this.chainHead = null;
    this.safeBlock = null;
    this.indexedBlock = null;
    this.eventsIndexed = 0;
    this.intentsIndexed = 0;
    this.fillsIndexed = 0;
    this.lastSuccessfulIndexAt = null;
    this.lastError = null;
  }

  setState(state: IndexerState): void {
    this.state = state;
  }

  /** Updates head/safe/indexed block after a poll cycle (or reorg) settles. */
  recordProgress(update: { chainHead: number; safeBlock: number; indexedBlock: number }): void {
    this.chainHead = update.chainHead;
    this.safeBlock = update.safeBlock;
    this.indexedBlock = update.indexedBlock;
  }

  /** Accumulates counts from a successfully persisted range. */
  recordIndexed(counts: { events: number; intents: number; fills: number }): void {
    this.eventsIndexed += counts.events;
    this.intentsIndexed += counts.intents;
    this.fillsIndexed += counts.fills;
    this.lastSuccessfulIndexAt = new Date().toISOString();
  }

  /** Records the error for observability. Does not itself change `state` — callers set ERROR
   * explicitly for unrecoverable failures; a transient error that will be retried next poll
   * should leave the lifecycle state as-is. */
  recordError(error: unknown): void {
    this.lastError = { message: String(error), at: new Date().toISOString() };
  }

  getSnapshot(): IndexerStatusSnapshot {
    return {
      chainId: this.chainId,
      state: this.state,
      chainHead: this.chainHead,
      safeBlock: this.safeBlock,
      indexedBlock: this.indexedBlock,
      lag: this.chainHead !== null && this.indexedBlock !== null ? this.chainHead - this.indexedBlock : null,
      eventsIndexed: this.eventsIndexed,
      intentsIndexed: this.intentsIndexed,
      fillsIndexed: this.fillsIndexed,
      lastSuccessfulIndexAt: this.lastSuccessfulIndexAt,
      lastError: this.lastError,
    };
  }
}

/** Singleton for the current process — one chain per indexer process. */
export const indexerStatus = new IndexerStatusService();
