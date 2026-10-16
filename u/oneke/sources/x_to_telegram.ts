import { createHmac, timingSafeEqual } from "node:crypto";
import wmill from "windmill-client";

type PostCreated = {
  data: {
    event_type: string;
    tag: string;
    payload: {
      id: string;
      text: string;
      created_at: string;
      note_tweet?: { text: string };
    };
  };
};

export async function preprocessor(event: {
  raw_string: string;
  headers: Record<string, string>;
}) {
  return {
    raw_body: event.raw_string,
    signature: event.headers["x-twitter-webhooks-signature-oauth2"],
  };
}

export async function main(raw_body: string, signature: string) {
  try {
    const credentials: RT.CXWebhook = await wmill.getResource("u/oneke/resources/x-webhook");
    const expected = "sha256=" + createHmac("sha256", credentials.client_secret)
      .update(raw_body)
      .digest("base64");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new Error("Invalid X webhook signature");
    }

    const { data }: PostCreated = JSON.parse(raw_body);
    if (data.event_type !== "post.create") {
      throw new Error(`Unsupported X event: ${data.event_type}`);
    }

    const post = data.payload;
    const text = Array.from(post.note_tweet?.text ?? post.text);
    const publishedAt = new Date(post.created_at)
      .toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
    const footer = `发布时间：${publishedAt} +08:00\n原帖：https://x.com/i/web/status/${post.id}`;
    const notifications: Promise<unknown>[] = [];

    // 1700 Unicode characters leave room for the header/footer even with emoji.
    // A media-only post still sends its timestamp and link.
    for (let offset = 0; offset < Math.max(text.length, 1); offset += 1700) {
      notifications.push(wmill.runFlow("u/oneke/channels/notification", {
        message: {
          level: "info",
          title: `X · ${data.tag}`,
          description: `${text.slice(offset, offset + 1700).join("")}\n\n${footer}`,
        },
      }));
    }

    await Promise.all(notifications);
    return { ok: true };
  } catch (error) {
    // Sync Windmill routes otherwise acknowledge failed scripts with HTTP 200.
    return { wm_status_code: 500, wm_failure: String(error) };
  }
}
