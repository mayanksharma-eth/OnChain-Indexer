import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Database } from "@onchain-indexer/database";
import { apiRequestDuration, apiRequestsTotal, metricsRegistry } from "@onchain-indexer/utils";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIntentRoutes } from "./routes/intents.js";
import { registerAddressRoutes } from "./routes/addresses.js";
import { registerSolverRoutes } from "./routes/solver.js";
import { registerIndexerStatusRoutes } from "./routes/indexer-status.js";
import { AppError, type AppState, type RedisClient } from "./lib/http.js";

export interface BuildAppOptions {
  db: Database;
  redis: RedisClient | null;
  logLevel: "debug" | "info" | "warn" | "error";
  state: AppState;
  /** Chain this API instance serves — see packages/config/src/api.ts. */
  chainId: number;
  /** Gates dev-only cache hit/miss logging (see lib/cache.ts). Defaults to "production" (silent). */
  nodeEnv?: string;
}

export function buildApp({ db, redis, logLevel, state, chainId, nodeEnv = "production" }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel } });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      error: { message: `route not found: ${request.method} ${request.url}`, code: "not_found" },
    });
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    request.log.error({ err: error }, "request error");

    if (error instanceof ZodError) {
      reply.code(400).send({
        success: false,
        error: { message: "validation failed", code: "validation_error", issues: error.issues },
      });
      return;
    }

    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        success: false,
        error: { message: error.message, code: error.code },
      });
      return;
    }

    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    reply.code(statusCode).send({
      success: false,
      error: {
        message: statusCode === 500 ? "internal server error" : error.message,
        code: "internal_error",
      },
    });
  });

  app.addHook("onResponse", (request, reply, done) => {
    // request.routeOptions.url is the route pattern (e.g. "/intents/:intentId"), not the literal
    // path — labeling by the resolved path would blow up cardinality with every intentId seen.
    const route = request.routeOptions.url ?? "unmatched";
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    apiRequestsTotal.inc(labels);
    apiRequestDuration.observe(labels, reply.elapsedTime / 1000);
    done();
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  app.register(
    (instance) => {
      registerHealthRoutes(instance, { db, redis, state });
      registerIntentRoutes(instance, { db, chainId, redis, nodeEnv });
      registerAddressRoutes(instance, { db, chainId });
      registerSolverRoutes(instance, { db, chainId, redis, nodeEnv });
      registerIndexerStatusRoutes(instance, { db, chainId, redis, nodeEnv });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
