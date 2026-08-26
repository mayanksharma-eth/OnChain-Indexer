import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { RedisClient } from "./lib/http.js";
import { db } from "./test-setup.js";

export function buildTestApp(chainId: number, options: { redis?: RedisClient | null; nodeEnv?: string } = {}): FastifyInstance {
  return buildApp({
    db,
    redis: options.redis ?? null,
    logLevel: "error",
    state: { initialized: true },
    chainId,
    nodeEnv: options.nodeEnv,
  });
}
