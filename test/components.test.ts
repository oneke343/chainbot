import assert from "node:assert/strict";
import test from "node:test";
import { main as sendFlashduty } from "../f/chain_sentinel/scripts/destinations/send_flashduty.ts";

test("FlashDuty Destination returns immediately when messages are empty", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async (
    _url: URL | RequestInfo,
    _init?: RequestInit,
  ): Promise<Response> => {
    fetchCalled = true;
    throw new Error("fetch must not be called");
  }) as unknown as typeof fetch;

  try {
    assert.equal(await sendFlashduty({ url: "", integration_key: "" }, null), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false);
});

test("FlashDuty batches are bounded", async () => {
  const message = {
    title: "x", description: "x", severity: "warning" as const, fields: {},
  };
  await assert.rejects(
    sendFlashduty({ url: "https://flashduty.example.test/alerts", integration_key: "test-only" }, Array(101).fill(message)),
    /at most 100/,
  );
});

test("FlashDuty Destination sends the standard alert payload", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: URL | RequestInfo, init: RequestInit = {}) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({
      request_id: "request-123",
      data: { alert_key: "monitor:root-flow" },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await sendFlashduty(
      {
        url: "https://flashduty.example.test/event/push/alert/standard?tenant=dev",
        integration_key: "flashduty-key",
      },
      [{
        title: "Aave health warning",
        description: "Health factor is below threshold",
        severity: "critical",
        fields: {
          market: "Ethereum Core",
          healthFactor: 1.04,
          context: { user: "0xuser" },
        },
      }],
      "monitor:root-flow",
    );

    assert.deepEqual(result, {
      destination: "flashduty",
      delivered: 1,
      results: [{
        delivered: true,
        request_id: "request-123",
        alert_key: "monitor:root-flow",
      }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured);
  assert.equal(
    captured.url,
    "https://flashduty.example.test/event/push/alert/standard?tenant=dev&integration_key=flashduty-key",
  );
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    title_rule: "Aave health warning",
    event_status: "Critical",
    alert_key: "monitor:root-flow:0",
    description: "Health factor is below threshold",
    labels: {
      market: "Ethereum Core",
      healthFactor: "1.04",
      context: '{"user":"0xuser"}',
      severity: "critical",
    },
  });
});

test("FlashDuty Destination exposes API errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    request_id: "request-456",
    error: { code: "InvalidParameter", message: "title_rule is required" },
  }), { status: 400 })) as unknown as typeof fetch;

  try {
    await assert.rejects(
      sendFlashduty(
        {
          url: "https://api.flashcat.cloud/event/push/alert/standard",
          integration_key: "flashduty-key",
        },
        [{
          title: "Aave warning",
          description: "Health factor is low",
          severity: "warning",
          fields: {},
        }],
      ),
      /InvalidParameter: title_rule is required/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
