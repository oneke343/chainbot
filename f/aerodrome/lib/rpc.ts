import {
  createPublicClient,
  http,
  type Abi,
  type Address,
} from "viem";
import { base } from "viem/chains";

export type Call = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
  abi?: Abi;
};
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

export async function many(
  client: PublicClient,
  block: bigint,
  calls: Call[],
  defaultAbi: Abi,
  optional = false,
  config?: ReadConfig,
): Promise<any[]> {
  if (!calls.length) return [];
  assert(calls.length > 1, "Use readOne for a single contract read");
  const { rpcChunkSize, rpcConcurrency } = readConfig(config);
  const entries = await mapChunksWithConcurrency(
    calls,
    rpcChunkSize,
    rpcConcurrency,
    async (part) => {
      const results = await client.multicall({
        blockNumber: block,
        allowFailure: true,
        batchSize: 0,
        contracts: part.map((c) => ({ ...c, abi: c.abi ?? defaultAbi })) as any,
      });
      return results.map((result, index) => ({ result, request: part[index] }));
    },
  );
  const out: any[] = new Array(calls.length);
  entries.forEach(({ result, request }, index) => {
    if (result.status === "failure") {
      assert(optional, `Contract read failed: ${request.address} ${request.functionName}`);
      out[index] = null;
    } else out[index] = result.result;
  });
  return out;
}

export async function readOne(
  client: PublicClient,
  block: bigint,
  request: Call,
  defaultAbi: Abi,
  optional = false,
): Promise<any> {
  try {
    return await client.readContract({
      blockNumber: block,
      address: request.address,
      abi: request.abi ?? defaultAbi,
      functionName: request.functionName,
      args: request.args,
    } as any);
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

export function call(address: Address, functionName: string, ...args: unknown[]): Call {
  return { address, functionName, args };
}
export function callWithAbi(
  address: Address,
  functionName: string,
  abi: Abi,
  ...args: unknown[]
): Call {
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
