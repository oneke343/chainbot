import {
  createPublicClient,
  http,
  type Abi,
  type Address,
} from "viem";
import { base } from "viem/chains";

/** A dynamic contract read with its decoded result type supplied by the adapter. */
export type Call<T = unknown> = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
  abi?: Abi;
};
type MulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; result?: undefined; error?: unknown };
export type PublicClient = ReturnType<typeof clientFor>;
export type ReadConfig = {
  rpcChunkSize?: number;
  rpcConcurrency?: number;
  poolViewAddress?: Address;
  poolViewPageSize?: number;
};

export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function count(n: bigint, limit: number, label: string) {
  assert(
    n >= 0n && n <= BigInt(limit),
    `${label} exceeds supported limit ${limit}; refusing partial discovery`,
  );
  return Number(n);
}
export function clientFor(rpcUrl: string) {
  assert(/^https?:\/\//.test(rpcUrl), "Invalid RPC URL");
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 30000, retryCount: 2 }),
  });
}

const DEFAULT_READ_CONFIG = { rpcChunkSize: 1000, rpcConcurrency: 4 } as const;
export function readConfig(config?: ReadConfig) {
  const chunkSize = config?.rpcChunkSize ?? DEFAULT_READ_CONFIG.rpcChunkSize;
  const concurrency = config?.rpcConcurrency ?? DEFAULT_READ_CONFIG.rpcConcurrency;
  assert(
    Number.isInteger(chunkSize) && chunkSize >= 100 && chunkSize <= 1000,
    "rpcChunkSize must be an integer from 100 to 1000",
  );
  assert(
    Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8,
    "rpcConcurrency must be an integer from 1 to 8",
  );
  return { rpcChunkSize: chunkSize, rpcConcurrency: concurrency };
}

async function mapChunksWithConcurrency<T, R>(
  items: readonly T[],
  chunkSize: number,
  concurrency: number,
  mapper: (chunk: readonly T[], chunkIndex: number) => Promise<readonly R[]>,
): Promise<R[]> {
  assert(Number.isInteger(chunkSize) && chunkSize >= 1, "Invalid chunk size");
  assert(Number.isInteger(concurrency) && concurrency >= 1, "Invalid concurrency");
  if (!items.length) return [];
  const chunks = Array.from(
    { length: Math.ceil(items.length / chunkSize) },
    (_, index) => items.slice(index * chunkSize, (index + 1) * chunkSize),
  );
  const chunkResults = new Array<readonly R[]>(chunks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const chunkIndex = next++;
      if (chunkIndex >= chunks.length) return;
      chunkResults[chunkIndex] = await mapper(chunks[chunkIndex], chunkIndex);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
  );
  return chunkResults.flatMap((results) => results);
}

export function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
  defaultAbi: Abi,
  optional?: false,
  config?: ReadConfig,
): Promise<T[]>;
export function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
  defaultAbi: Abi,
  optional: true,
  config?: ReadConfig,
): Promise<(T | null)[]>;
export function many<T>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
  defaultAbi: Abi,
  optional: boolean,
  config?: ReadConfig,
): Promise<(T | null)[]>;
export async function many<T = unknown>(
  client: PublicClient,
  block: bigint,
  calls: readonly Call<T>[],
  defaultAbi: Abi,
  optional = false,
  config?: ReadConfig,
): Promise<(T | null)[]> {
  if (!calls.length) return [];
  assert(calls.length > 1, "Use readOne for a single contract read");
  const { rpcChunkSize, rpcConcurrency } = readConfig(config);
  const entries = await mapChunksWithConcurrency(
    calls,
    rpcChunkSize,
    rpcConcurrency,
    async (part) => {
      const results = (await client.multicall(
        {
          blockNumber: block,
          allowFailure: true,
          batchSize: 0,
          contracts: part.map((c) => ({
            ...c,
            abi: c.abi ?? defaultAbi,
          })) as Parameters<PublicClient["multicall"]>[0]["contracts"],
        } as Parameters<PublicClient["multicall"]>[0],
      )) as MulticallResult[];
      return results.map((result, index) => ({ result, request: part[index] }));
    },
  );
  const out: (T | null)[] = new Array(calls.length);
  entries.forEach(({ result, request }, index) => {
    if (result.status === "failure") {
      assert(optional, `Contract read failed: ${request.address} ${request.functionName}`);
      out[index] = null;
    } else out[index] = result.result as T;
  });
  return out;
}

export function readOne<T>(
  client: PublicClient,
  block: bigint,
  request: Call<T>,
  defaultAbi: Abi,
  optional?: false,
): Promise<T>;
export function readOne<T>(
  client: PublicClient,
  block: bigint,
  request: Call<T>,
  defaultAbi: Abi,
  optional: true,
): Promise<T | null>;
export async function readOne<T = unknown>(
  client: PublicClient,
  block: bigint,
  request: Call<T>,
  defaultAbi: Abi,
  optional = false,
): Promise<T | null> {
  try {
    return (await client.readContract({
      blockNumber: block,
      address: request.address,
      abi: request.abi ?? defaultAbi,
      functionName: request.functionName,
      args: request.args,
    } as Parameters<PublicClient["readContract"]>[0])) as T;
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

export function call<T = unknown>(
  address: Address,
  functionName: string,
  ...args: unknown[]
): Call<T> {
  return { address, functionName, args };
}
export function callWithAbi<T = unknown>(
  address: Address,
  functionName: string,
  abi: Abi,
  ...args: unknown[]
): Call<T> {
  return { address, functionName, args, abi };
}

/** Run one mapper per item with a bounded number of in-flight calls. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  assert(Number.isInteger(concurrency) && concurrency >= 1, "Invalid concurrency");
  const result = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return result;
}
