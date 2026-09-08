//native

export async function main(
  connection: RT.HttpConnection,
  path: string,
  message?: RT.AlertMessage | null,
) {
  if (!message) return;
  if (!connection?.base_url) throw new Error("connection.base_url is required");
  const base = new URL(connection.base_url);
  const normalizedBase = base.href.endsWith("/") ? base : new URL(`${base.href}/`);
  const url = new URL(path || ".", normalizedBase);
  if (url.origin !== base.origin) throw new Error("webhook path must not change the connection origin");
  const headers = new Headers({ "Content-Type": "application/json", ...connection.headers });
  if (connection.bearer_token) headers.set("Authorization", `Bearer ${connection.bearer_token}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Webhook delivery failed (${response.status}): ${responseText.slice(0, 500)}`);
  }
  return { destination: "webhook", delivered: true };
}
