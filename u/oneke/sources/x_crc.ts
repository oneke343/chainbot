import { createHmac } from "node:crypto";
import wmill from "windmill-client";

export async function preprocessor(event: { query: Record<string, string> }) {
  return { crc_token: event.query.crc_token };
}

export async function main(crc_token: string) {
  const credentials: RT.CXWebhook = await wmill.getResource("u/oneke/resources/x-webhook");
  const digest = createHmac("sha256", credentials.client_secret)
    .update(crc_token)
    .digest("base64");
  return { response_token: `sha256=${digest}` };
}
