//native

type SparkAccount = {
  name: string;
  chain_id: number;
  chain_name: string;
  pool_address: string;
  total_collateral: string;
  total_debt: string;
  health_factor: string | null;
};

export async function main(config: RT.SparkLend, user: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error("user must be an EVM address");
  if (!Array.isArray(config?.markets) || !config.markets.length) throw new Error("SparkLend markets are required");
  const ids = new Set<string>();
  const accounts = await Promise.all(config.markets.map(async (market) => {
    const id = `${market.chain_id}:${market.pool_address.toLowerCase()}`;
    if (ids.has(id)) throw new Error(`Duplicate SparkLend market: ${id}`);
    ids.add(id);
    validateMarket(market);
    const data = `0xbf92857c${user.slice(2).toLowerCase().padStart(64, "0")}`;
    const response = await fetch(market.rpc_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...market.rpc_headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [
        { to: market.pool_address, data }, "latest",
      ] }),
    });
    const body = await response.json() as { result?: string; error?: { code?: number; message?: string } };
    if (!response.ok || body.error) throw new Error(`SparkLend RPC failed for ${market.name}: ${body.error?.message ?? response.status}`);
    const values = decodeWords(body.result);
    const decimals = market.base_currency_decimals ?? 8;
    return {
      name: market.name,
      chain_id: market.chain_id,
      chain_name: market.chain_name,
      pool_address: market.pool_address.toLowerCase(),
      total_collateral: formatUnits(values[0], decimals),
      total_debt: formatUnits(values[1], decimals),
      health_factor: values[1] === 0n ? null : formatUnits(values[5], 18),
    } satisfies SparkAccount;
  }));
  return { user, observed_at: new Date().toISOString(), accounts };
}

function validateMarket(market: RT.SparkLend["markets"][number]): void {
  if (!market.name || !market.chain_name || !Number.isSafeInteger(market.chain_id) || market.chain_id <= 0
    || !/^0x[0-9a-fA-F]{40}$/.test(market.pool_address)) throw new Error("Invalid SparkLend market");
  const url = new URL(market.rpc_url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("SparkLend RPC must use http or https");
}

function decodeWords(result: unknown): bigint[] {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{384}$/.test(result)) {
    throw new Error("Invalid SparkLend getUserAccountData result");
  }
  return Array.from({ length: 6 }, (_, index) => BigInt(`0x${result.slice(2 + index * 64, 66 + index * 64)}`));
}

function formatUnits(value: bigint, decimals: number): string {
  const text = value.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return text;
  const fraction = text.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${text.slice(0, -decimals)}.${fraction}` : text.slice(0, -decimals);
}
