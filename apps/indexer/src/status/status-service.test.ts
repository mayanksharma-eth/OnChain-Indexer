import { describe, expect, it } from "vitest";
import { IndexerStatusService } from "./status-service.js";

describe("IndexerStatusService", () => {
  it("starts in STARTING state with everything zeroed", () => {
    const status = new IndexerStatusService();
    status.start(31337);

    expect(status.getSnapshot()).toMatchObject({
      chainId: 31337,
      state: "STARTING",
      chainHead: null,
      safeBlock: null,
      indexedBlock: null,
      lag: null,
      eventsIndexed: 0,
      intentsIndexed: 0,
      fillsIndexed: 0,
      lastSuccessfulIndexAt: null,
      lastError: null,
    });
  });

  it("computes lag from chainHead and indexedBlock once progress is recorded", () => {
    const status = new IndexerStatusService();
    status.start(1);
    status.recordProgress({ chainHead: 100, safeBlock: 95, indexedBlock: 90 });

    const snapshot = status.getSnapshot();
    expect(snapshot).toMatchObject({ chainHead: 100, safeBlock: 95, indexedBlock: 90, lag: 10 });
  });

  it("accumulates events/intents/fills across multiple recordIndexed calls", () => {
    const status = new IndexerStatusService();
    status.start(1);
    status.recordIndexed({ events: 5, intents: 2, fills: 1 });
    status.recordIndexed({ events: 3, intents: 1, fills: 0 });

    const snapshot = status.getSnapshot();
    expect(snapshot).toMatchObject({ eventsIndexed: 8, intentsIndexed: 3, fillsIndexed: 1 });
    expect(snapshot.lastSuccessfulIndexAt).not.toBeNull();
  });

  it("setState transitions through the lifecycle states", () => {
    const status = new IndexerStatusService();
    status.start(1);

    for (const state of ["BACKFILLING", "SYNCING", "CAUGHT_UP", "REORGING", "ERROR", "STOPPED"] as const) {
      status.setState(state);
      expect(status.getSnapshot().state).toBe(state);
    }
  });

  it("records the last error without changing state", () => {
    const status = new IndexerStatusService();
    status.start(1);
    status.setState("SYNCING");

    status.recordError(new Error("rpc timeout"));

    const snapshot = status.getSnapshot();
    expect(snapshot.state).toBe("SYNCING");
    expect(snapshot.lastError?.message).toContain("rpc timeout");
    expect(snapshot.lastError?.at).toBeTruthy();
  });

  it("start() resets all fields, including a prior error and counts", () => {
    const status = new IndexerStatusService();
    status.start(1);
    status.recordIndexed({ events: 5, intents: 1, fills: 1 });
    status.recordError(new Error("boom"));
    status.setState("ERROR");

    status.start(2);

    expect(status.getSnapshot()).toMatchObject({
      chainId: 2,
      state: "STARTING",
      eventsIndexed: 0,
      intentsIndexed: 0,
      fillsIndexed: 0,
      lastError: null,
    });
  });
});
