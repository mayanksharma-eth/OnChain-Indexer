export class RpcError extends Error {
  readonly context?: Record<string, unknown>;

  constructor(message: string, options?: { cause?: unknown; context?: Record<string, unknown> }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RpcError";
    this.context = options?.context;
  }
}

export class RpcRetriesExhaustedError extends RpcError {
  constructor(method: string, attempts: number, cause: unknown) {
    super(`RPC method "${method}" failed after ${attempts} attempt(s)`, {
      cause,
      context: { method, attempts },
    });
    this.name = "RpcRetriesExhaustedError";
  }
}

export class ChainIdMismatchError extends RpcError {
  constructor(expected: number, actual: number) {
    super(`Configured CHAIN_ID (${expected}) does not match the RPC endpoint's chain ID (${actual})`, {
      context: { expected, actual },
    });
    this.name = "ChainIdMismatchError";
  }
}
