import { createPublicClient, http, type Block, type Hash, type Log, type PublicClient } from "viem";
import { indexerRpcErrorsTotal } from "@onchain-indexer/utils";
import { ChainIdMismatchError } from "./errors.js";
import { withRetry } from "./retry.js";

export interface RpcClientConfig {
  rpcUrl: string;
  chainId: number;
  /** Number of retries after the initial attempt. Default: 5. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Default: 200. */
  baseDelayMs?: number;
}

/** The subset of viem's PublicClient the RPC layer depends on — narrow enough to fake in tests. */
export type MinimalPublicClient = Pick<PublicClient, "getChainId" | "getBlock" | "getLogs">;

export interface RpcClient {
  getChainId(): Promise<number>;
  getLatestBlock(): Promise<Block>;
  getBlock(blockNumber: number | bigint): Promise<Block>;
  getBlockByHash(hash: Hash): Promise<Block>;
  getLogs(fromBlock: number | bigint, toBlock: number | bigint): Promise<Log[]>;
}

/** Builds an RPC client against the configured RPC_URL and validates it's actually serving
 * the configured CHAIN_ID before returning — call this once at startup. */
export async function createRpcClient(
  config: RpcClientConfig,
  overrides?: { publicClient?: MinimalPublicClient },
): Promise<RpcClient> {
  const publicClient = overrides?.publicClient ?? createPublicClient({ transport: http(config.rpcUrl) });
  const maxRetries = config.maxRetries ?? 5;
  const baseDelayMs = config.baseDelayMs ?? 200;

  function call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      method,
      maxRetries,
      baseDelayMs,
      onError: () => indexerRpcErrorsTotal.inc({ chain_id: config.chainId, method }),
    });
  }

  const client: RpcClient = {
    getChainId: () => call("getChainId", () => publicClient.getChainId()),
    getLatestBlock: () => call("getLatestBlock", () => publicClient.getBlock()),
    getBlock: (blockNumber) =>
      call("getBlock", () => publicClient.getBlock({ blockNumber: BigInt(blockNumber) })),
    getBlockByHash: (hash) => call("getBlockByHash", () => publicClient.getBlock({ blockHash: hash })),
    getLogs: (fromBlock, toBlock) =>
      call("getLogs", () => publicClient.getLogs({ fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) })),
  };

  const actualChainId = await client.getChainId();
  if (actualChainId !== config.chainId) {
    throw new ChainIdMismatchError(config.chainId, actualChainId);
  }

  return client;
}
