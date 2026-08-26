import { Counter, Gauge, Histogram, Registry } from "prom-client";

/** One registry per process. Both apps (indexer, api) import their own metric objects below —
 * they never share a process, so a single module-level registry is enough. */
export const metricsRegistry = new Registry();

export const indexerBlocksProcessedTotal = new Counter({
  name: "indexer_blocks_processed_total",
  help: "Blocks persisted by the indexing pipeline",
  labelNames: ["chain_id"],
  registers: [metricsRegistry],
});

export const indexerEventsProcessedTotal = new Counter({
  name: "indexer_events_processed_total",
  help: "Decoded events persisted by the indexing pipeline",
  labelNames: ["chain_id"],
  registers: [metricsRegistry],
});

export const indexerRpcErrorsTotal = new Counter({
  name: "indexer_rpc_errors_total",
  help: "Failed RPC calls, including ones that were retried",
  labelNames: ["chain_id", "method"],
  registers: [metricsRegistry],
});

export const indexerReorgsTotal = new Counter({
  name: "indexer_reorgs_total",
  help: "Chain reorgs detected and handled",
  labelNames: ["chain_id"],
  registers: [metricsRegistry],
});

export const indexerBlockLag = new Gauge({
  name: "indexer_block_lag",
  help: "Blocks between chain head and the last indexed block",
  labelNames: ["chain_id"],
  registers: [metricsRegistry],
});

export const indexerProcessingDuration = new Histogram({
  name: "indexer_processing_duration_seconds",
  help: "Time to fetch, decode, and persist one block range",
  labelNames: ["chain_id"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

export const apiRequestsTotal = new Counter({
  name: "api_requests_total",
  help: "HTTP requests handled by the API",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

export const apiRequestDuration = new Histogram({
  name: "api_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});
