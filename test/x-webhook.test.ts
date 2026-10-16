import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import wmill from "windmill-client";
import { main as crc, preprocessor as crcInput } from "../u/oneke/sources/x_crc.ts";
import { main as forward, preprocessor as postInput } from "../u/oneke/sources/x_to_telegram.ts";

const secret = "test-client-secret";
const raw = '{"data":{"event_type":"post.create","tag":"@PeckShieldAlert","payload":{"id":"1234567890123456789","text":"Suspicious transaction detected","created_at":"2026-10-16T06:00:00Z"}}}';
// Independent Python hmac/hashlib fixture, not calculated by the handler under test.
const signature = "sha256=SWsuCS/ZcMVzFYQagHnNJ6DtzJR4KZ180Vq5drqu87A=";

function signingResource(t: TestContext) {
  t.mock.method(wmill, "runFlowAsync", () => {
    assert.fail("notifications must use runFlow and wait for completion");
  });
  return t.mock.method(wmill, "getResource", async (path: string) => {
    assert.equal(path, "u/oneke/resources/x-webhook");
    return { client_secret: secret };
  });
}

test("CRC returns the X protocol token using the server-side client secret", async (t) => {
  signingResource(t);
  const input = await crcInput({ query: { crc_token: "crc-test-token", client_secret: "attacker" } });
  assert.deepEqual(await crc(input.crc_token), {
    response_token: "sha256=7oFJc/MerTFzvdakYJg7XOkudiRuKAWbnsluHrSq6OY=",
  });
});

test("a signed X post sends the existing info notification and returns only ok", async (t) => {
  signingResource(t);
  const notify = t.mock.method(wmill, "runFlow", async (path, args) => {
    assert.equal(path, "u/oneke/channels/notification");
    assert.deepEqual(args, {
      message: {
        level: "info",
        title: "X · @PeckShieldAlert",
        description: "Suspicious transaction detected\n\n发布时间：2026-10-16 14:00:00 +08:00\n原帖：https://x.com/i/web/status/1234567890123456789",
      },
    });
    return { message_id: 123 };
  });
  const input = await postInput({
    raw_string: raw,
    headers: { "x-twitter-webhooks-signature-oauth2": signature },
  });
  assert.deepEqual(await forward(input.raw_body, input.signature), {
    ok: true,
  });
  assert.equal(notify.mock.callCount(), 1);
});

test("notification flows start in parallel and the response waits for every result", async (t) => {
  signingResource(t);
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  let started = 0;
  const notify = t.mock.method(wmill, "runFlow", () => gates[started++].promise);
  const event = JSON.parse(raw);
  event.data.payload.text = "a".repeat(2000);
  const body = JSON.stringify(event);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("base64");
  let settled = false;
  const response = forward(body, sig).finally(() => { settled = true; });
  try {
    await setImmediate();
    assert.equal(notify.mock.callCount(), 2);
    assert.equal(settled, false);
    gates[1].resolve({ message_id: 2 });
    await setImmediate();
    assert.equal(settled, false);
    gates[0].resolve({ message_id: 1 });
    assert.deepEqual(await response, {
      ok: true,
    });
  } finally {
    for (const gate of gates) gate.resolve(undefined);
    await response;
  }
});

test("altered body, invalid signature and missing signature never send a notification", async (t) => {
  signingResource(t);
  const notify = t.mock.method(wmill, "runFlow", async () => {
    assert.fail("an unauthenticated request must not send a notification");
  });
  for (const [body, sig] of [
    [raw.replace("Suspicious", "Untrusted"), signature],
    [raw, signature.replace("SWsu", "AAAA")],
    [raw, "sha256=short"],
    [raw, undefined],
    [JSON.stringify(JSON.parse(raw), null, 2), signature],
  ]) {
    const result = await forward(body, sig);
    assert.equal(result.wm_status_code, 500);
    assert.ok(result.wm_failure);
    assert.equal("results" in result, false);
  }
  assert.equal(notify.mock.callCount(), 0);
});

test("signed malformed payloads are rejected before notifying", async (t) => {
  signingResource(t);
  const sign = (body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("base64");
  const notify = t.mock.method(wmill, "runFlow", async () => { throw new Error("Telegram unavailable"); });
  const malformed = await forward("not json", sign("not json"));
  assert.equal(malformed.wm_status_code, 500);
  assert.match(malformed.wm_failure, /^SyntaxError:/);
  const unsupported = raw.replace("post.create", "post.delete");
  assert.deepEqual(await forward(unsupported, sign(unsupported)), {
    wm_status_code: 500,
    wm_failure: "Error: Unsupported X event: post.delete",
  });
  assert.equal(notify.mock.callCount(), 0);
});

test("notification failure marks the Windmill Job failed and returns a retryable HTTP error", async (t) => {
  signingResource(t);
  t.mock.method(wmill, "runFlow", async () => { throw new Error("Telegram unavailable"); });
  const result = await forward(raw, signature);
  assert.deepEqual(result, {
    wm_status_code: 500,
    wm_failure: "Error: Telegram unavailable",
  });
  assert.equal("results" in result, false);
});

test("resource failures and partial notification failures are not acknowledged as success", async (t) => {
  const resource = signingResource(t);
  const notify = t.mock.method(wmill, "runFlow", async () => ({ message_id: 1 }));
  resource.mock.mockImplementationOnce(async () => { throw new Error("Resource unavailable"); });
  assert.deepEqual(await forward(raw, signature), {
    wm_status_code: 500,
    wm_failure: "Error: Resource unavailable",
  });
  assert.equal(notify.mock.callCount(), 0);

  notify.mock.mockImplementationOnce(async () => { throw new Error("Second notification failed"); }, 1);
  const event = JSON.parse(raw);
  event.data.payload.text = "a".repeat(2000);
  const body = JSON.stringify(event);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("base64");
  assert.deepEqual(await forward(body, sig), {
    wm_status_code: 500,
    wm_failure: "Error: Second notification failed",
  });
  assert.equal(notify.mock.callCount(), 2);
});

test("long Unicode posts retain all text and fit Telegram's limit; media-only posts retain their link", async (t) => {
  signingResource(t);
  const delivered: { title: string; description: string }[] = [];
  t.mock.method(wmill, "runFlow", async (_path, args) => {
    delivered.push(args.message);
    return { message_id: delivered.length };
  });
  for (const text of ["警报🚨\n".repeat(1300), ""]) {
    delivered.length = 0;
    const event = JSON.parse(raw);
    event.data.payload.text = "short preview";
    event.data.payload.note_tweet = { text };
    const body = JSON.stringify(event);
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("base64");
    await forward(body, sig);
    assert.ok(delivered.length >= 1);
    const reconstructed = delivered.map(({ title, description }) => {
      assert.ok(`[info] ${title}\n\n${description}`.length <= 4096);
      assert.ok(description.endsWith("https://x.com/i/web/status/1234567890123456789"));
      return description.split("\n\n发布时间：")[0];
    }).join("");
    assert.equal(reconstructed, text);
  }
});

test("HTTP routes share one callback, run preprocessors, and preserve the signed body", () => {
  const parse = (path: string) => JSON.parse(execFileSync("bun", ["-e",
    "console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))",
  ], { input: readFileSync(new URL(path, import.meta.url)), encoding: "utf8" }));
  const get = parse("../u/oneke/sources/x_crc.http_trigger.yaml");
  const post = parse("../u/oneke/sources/x_to_telegram.http_trigger.yaml");
  assert.equal(get.route_path, post.route_path);
  assert.equal(get.http_method, "get");
  assert.equal(post.http_method, "post");
  assert.equal(post.raw_string, true);
  for (const route of [get, post]) {
    assert.equal(route.request_type, "sync");
    assert.equal(route.authentication_method, "none");
    assert.equal(route.workspaced_route, true);
    const metadata = parse(`../${route.script_path}.script.yaml`);
    assert.equal(metadata.has_preprocessor, true);
  }
});
