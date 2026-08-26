import { describe, expect, it } from "vitest";
import { logger } from "@onchain-indexer/utils";

describe("logger", () => {
  it("logs structured JSON without throwing", () => {
    expect(() => logger.info("smoke test", { ok: true })).not.toThrow();
  });
});
