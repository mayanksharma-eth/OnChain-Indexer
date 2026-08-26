export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
