import Fastify from "fastify";
import { loadApiConfig } from "@onchain-indexer/config";
import { logger } from "@onchain-indexer/utils";

const API_HOST = "0.0.0.0";

const config = loadApiConfig();
const app = Fastify();

app.get("/health", () => ({ status: "ok" }));

app
  .listen({ port: config.API_PORT, host: API_HOST })
  .then((address) => logger.info("api listening", { address }))
  .catch((error: unknown) => {
    logger.error("failed to start api", { error: String(error) });
    process.exit(1);
  });
