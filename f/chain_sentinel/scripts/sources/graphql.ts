//native

/** Execute a query; partial GraphQL responses are failures, not healthy snapshots. */
export async function main(
  api: RT.Graphql,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(api.base_url);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid GraphQL URL");
  if (!query.trim()) throw new Error("GraphQL query is required");
  const headers = new Headers({ "Content-Type": "application/json", ...api.custom_headers });
  if (api.bearer_token) headers.set("Authorization", `Bearer ${api.bearer_token}`);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const result = await response.json() as {
    data?: unknown;
    errors?: { message: string }[];
  };
  if (result.errors?.length) {
    throw new Error(`GraphQL: ${result.errors.map((error) => error.message).join("; ")}`);
  }
  if (!result.data || typeof result.data !== "object") throw new Error("Missing GraphQL data");
  return result.data;
}
