//native

type QueryValue = string | number | boolean | null | undefined
  | Array<string | number | boolean | null | undefined>;

function buildUrl(
  connection: RT.HttpConnection,
  path: string,
  query: Record<string, QueryValue>,
): URL {
  if (!connection?.base_url) throw new Error("connection.base_url is required");
  const base = new URL(connection.base_url);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("connection.base_url must use HTTP or HTTPS");
  }
  if (typeof path !== "string" || /^https?:\/\//i.test(path)) {
    throw new Error("path must be relative to connection.base_url");
  }

  const normalizedBase = base.href.endsWith("/") ? base : new URL(`${base.href}/`);
  const url = new URL(path || ".", normalizedBase);
  if (url.origin !== base.origin) throw new Error("path must not change the connection origin");
  for (const [key, rawValue] of Object.entries(query ?? {})) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== null && value !== undefined) url.searchParams.append(key, String(value));
    }
  }
  return url;
}

export async function main(
  connection: RT.HttpConnection,
  path: string,
  method = "GET",
  query: Record<string, QueryValue> = {},
  body: unknown = null,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const url = buildUrl(connection, path, query);
  const requestHeaders = new Headers({
    Accept: "application/json",
    ...connection.headers,
    ...headers,
  });
  if (connection.bearer_token) {
    requestHeaders.set("Authorization", `Bearer ${connection.bearer_token}`);
  }

  const normalizedMethod = method.toUpperCase();
  const hasBody = body !== null && body !== undefined && normalizedMethod !== "GET";
  if (hasBody && !requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    method: normalizedMethod,
    headers: requestHeaders,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP JSON request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP endpoint returned invalid JSON: ${text.slice(0, 500)}`);
  }
}
