import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { main as evaluateMatchedOutput } from "../f/chain_sentinel/scripts/alert_policies/matched_output.ts";
import { main as sendFlashduty } from "../f/chain_sentinel/scripts/destinations/send_flashduty.ts";
import { main as sendTelegram } from "../f/chain_sentinel/scripts/destinations/send_telegram.ts";
import { main as sendWebhook } from "../f/chain_sentinel/scripts/destinations/send_webhook.ts";
import {
  createMonitorState,
  emptyMonitorState,
  monitorStatePath,
  normalizeMonitorOutput,
  normalizeMonitorState,
  resolveRootFlowPath,
} from "../f/chain_sentinel/lib/monitor-state.ts";
import { renderMessage } from "../f/chain_sentinel/lib/render-message.ts";
import { evaluateAaveHealth } from "../f/aave/scripts/rules/evaluate_aave_health.ts";
import {
  evaluateSpotPriceChange,
  type BinancePriceInputs,
} from "../f/binance/scripts/rules/evaluate_spot_price_change.ts";
import {
  normalizeSpotKlines,
  type SpotKline,
} from "../f/binance/scripts/sources/spot_klines.ts";
import { main as requestJson } from "../f/chain_sentinel/scripts/sources/http_json.ts";

function rawBinanceKline(
  openTime: number,
  close: string,
  quoteVolume = "1000",
  tradeCount = 10,
): unknown[] {
  return [
    openTime,
    close,
    close,
    close,
    close,
    "1",
    openTime + 59_999,
    quoteVolume,
    tradeCount,
    "0",
    "0",
    "0",
  ];
}

function binancePriceInputs(
  closes: string[],
  quoteVolume = "1000",
  tradeCount = 10,
): BinancePriceInputs {
  const klines: SpotKline[] = closes.map((close, index) => ({
    openTime: index * 60_000,
    closeTime: index * 60_000 + 59_999,
    close,
    high: close,
    low: close,
    quoteVolume,
    tradeCount,
  }));
  return {
    binance_spot_klines: {
      symbol: "BTCUSDT",
      interval: "1m",
      observedAt: klines[klines.length - 1].closeTime,
      klines,
    },
  };
}

test("MonitorState is stored below the Root Flow path", async () => {
  const rootFlowPath = await resolveRootFlowPath({
    async getRootJobId() {
      return "root-job";
    },
    async getJob(id) {
      assert.equal(id, "root-job");
      return { script_path: "u/alice/aave_health_monitor" };
    },
  });

  assert.equal(rootFlowPath, "u/alice/aave_health_monitor");
  assert.equal(
    monitorStatePath(rootFlowPath),
    "u/alice/aave_health_monitor/__monitor_state",
  );
  assert.deepEqual(emptyMonitorState(), {
    inputs: {},
    states: {},
    outputs: { matched: false, messages: [], fields: {} },
  });
  assert.throws(() => monitorStatePath("not-a-windmill-path"));
});

test("MonitorState contains only Source inputs, Rule states, and Rule outputs", () => {
  const inputs = { positions: [{ market: "Ethereum Core" }] };
  const states = { previousHealthFactor: "1.2" };
  const outputs = { matched: true, messages: [], fields: { healthFactor: "1.05" } };
  const state = createMonitorState(inputs, states, outputs);

  assert.deepEqual(state, {
    inputs,
    states,
    outputs: { matched: true, messages: [], fields: { healthFactor: "1.05" } },
  });
  assert.deepEqual(normalizeMonitorState(state), state);
  assert.throws(() => normalizeMonitorState({ inputs, states }));
  assert.throws(() => normalizeMonitorState({ inputs, states, outputs: {} }));
  assert.deepEqual(normalizeMonitorState({
    inputs,
    states,
    outputs: {
      matched: true,
      message: { title: "Legacy", description: "Stored before messages migration" },
      fields: {},
    },
  }).outputs.messages, [{ title: "Legacy", description: "Stored before messages migration" }]);
  assert.throws(() => normalizeMonitorState({
    inputs,
    states,
    outputs: { matched: true, fields: {}, message: { title: "", description: "x" } },
  }));
});

test("MonitorOutput contains only the public Rule result", () => {
  const output = {
    matched: true,
    messages: [
      {
        title: "Aave warning",
        description: "Health factor is low",
        fields: { position_id: "ethereum-main" },
      },
      { title: "Aave critical", description: "Health factor is below one" },
    ],
    fields: { healthFactor: "1.04" },
  };

  assert.deepEqual(normalizeMonitorOutput(output), output);
  assert.deepEqual(normalizeMonitorOutput({
    matched: true,
    message: { title: "Legacy warning", description: "Legacy state" },
    fields: {},
  }), {
    matched: true,
    messages: [{ title: "Legacy warning", description: "Legacy state" }],
    fields: {},
  });
  assert.throws(() => normalizeMonitorOutput({ matched: true, fields: {}, states: {} }));
  assert.throws(() => normalizeMonitorOutput({
    matched: true,
    fields: {},
    messages: [{ title: "Aave warning", description: "Health factor is low", severity: "critical" }],
  }));
  assert.throws(() => normalizeMonitorOutput({ matched: true }));
});

test("renderMessage renders monitor inputs and states", () => {
  assert.equal(
    renderMessage(
      "Account {{states.user}} breached: {{states.markets}}",
      { inputs: {}, states: { user: "0xuser", markets: ["Ethereum Core", "Base Core"] } },
    ),
    "Account 0xuser breached: Ethereum Core, Base Core",
  );
  assert.throws(() => renderMessage("{{states.missing}}", { inputs: {}, states: {} }));
});

test("REST Source composes one Resource with per-run request data", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL | RequestInfo, init: RequestInit = {}) => {
    captured = { url: String(url), init };
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  let result: unknown;
  try {
    result = await requestJson(
      {
        base_url: "https://example.test/api/",
        bearer_token: "secret",
        headers: { "X-Connection": "shared" },
      },
      "positions",
      "POST",
      { chain: [1, 10], ignored: null },
      { user: "0xabc" },
      { "X-Run": "monitor-a" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured);
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, "https://example.test/api/positions?chain=1&chain=10");
  const capturedHeaders = new Headers(captured.init.headers);
  assert.equal(capturedHeaders.get("Authorization"), "Bearer secret");
  assert.equal(capturedHeaders.get("X-Connection"), "shared");
  assert.equal(capturedHeaders.get("X-Run"), "monitor-a");
  assert.equal(captured.init.body, '{"user":"0xabc"}');
});

test("Aave Rules evaluate configured markets from current Source inputs", async () => {
  const inputs = {
    aave_market_positions: {
      markets: [
        {
          name: "Ethereum Core",
          address: `0x${"1".repeat(40)}`,
          chain: { chainId: 1, name: "Ethereum" },
          userState: { healthFactor: "1.04", totalDebtBase: "100", totalCollateralBase: "150" },
        },
        {
          name: "Base Core",
          address: `0x${"2".repeat(40)}`,
          chain: { chainId: 8453, name: "Base" },
          userState: { healthFactor: null },
        },
        {
          name: "Not Configured",
          address: `0x${"3".repeat(40)}`,
          chain: { chainId: 10, name: "OP Mainnet" },
          userState: { healthFactor: "0.5" },
        },
      ],
    },
  };

  const result = await evaluateAaveHealth(
    inputs,
    `0x${"4".repeat(40)}`,
    { "Ethereum Core": 1.1, "Base Core": 1.05, Missing: 1.2 },
  );

  assert.equal(result.output.matched, true);
  const positions = result.output.fields.positions as Array<{market_name: string; breached: boolean}>;
  assert.equal(positions.length, 1);
  assert.equal(positions[0].market_name, "Ethereum Core");
  assert.equal(positions[0].breached, true);
  assert.deepEqual(result.output.fields.unused_thresholds, ["Missing"]);
  assert.equal(result.states.breached_count, 1);
  assert.equal(result.output.messages?.length, 1);
  assert.equal(result.output.messages[0].title, "Aave V3 position risk: health_factor_threshold");
  assert.match(result.output.messages[0].description, /HF threshold: 1\.1/);
  assert.equal(result.output.messages[0].fields?.finding_id, `health_factor:1:0x${"1".repeat(40)}`);

  const withDefault = evaluateAaveHealth(
    inputs, `0x${"4".repeat(40)}`, { "Ethereum Core": 1.1 }, 1,
  );
  assert.deepEqual(
    (withDefault.output.fields.positions as Array<{ market_name: string }>).map((item) => item.market_name),
    ["Not Configured", "Ethereum Core"],
  );
});

test("Binance Source keeps only fresh closed one-minute klines", () => {
  const response = [
    rawBinanceKline(0, "100"),
    rawBinanceKline(60_000, "101"),
    rawBinanceKline(120_000, "102"),
    rawBinanceKline(180_000, "103"),
  ];

  const result = normalizeSpotKlines(response, "btcusdt", 2, 180_500);

  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.observedAt, 179_999);
  assert.deepEqual(result.klines.map((kline) => kline.close), ["100", "101", "102"]);
  assert.throws(
    () => normalizeSpotKlines(response.slice(0, 2), "BTCUSDT", 2, 180_500),
    /3 are required/,
  );
  assert.throws(
    () => normalizeSpotKlines([response[0], response[2], response[3]], "BTCUSDT", 2, 240_500),
    /gap/,
  );
});

test("Binance price rules use OR semantics and emit one transition", () => {
  const inputs = binancePriceInputs(["100", "100", "100", "96", "94", "90"]);
  const rules = [
    {
      id: "drop_5m",
      window_minutes: 5,
      direction: "down" as const,
      threshold_percent: 8,
    },
    {
      id: "move_2m",
      window_minutes: 2,
      direction: "either" as const,
      threshold_percent: 6,
    },
    {
      id: "rise_2m",
      window_minutes: 2,
      direction: "up" as const,
      threshold_percent: 3,
    },
  ];

  const first = evaluateSpotPriceChange(inputs, rules);
  assert.equal(first.output.matched, true);
  assert.deepEqual(first.output.fields.newlyTriggeredRuleIds, ["drop_5m", "move_2m"]);
  assert.deepEqual(first.output.fields.activeRuleIds, ["drop_5m", "move_2m"]);
  assert.ok(Math.abs(first.output.fields.rules.drop_5m.changePercent + 10) < 1e-12);
  assert.equal(first.output.fields.rules.move_2m.changePercent, -6.25);
  assert.equal(first.output.fields.rules.rise_2m.status, "normal");
  assert.match(first.output.messages?.[0]?.description ?? "", /\| drop_5m \| 5m \| down/);
  assert.match(first.output.messages?.[0]?.description ?? "", /Newly triggered rules: drop_5m, move_2m/);

  const repeated = evaluateSpotPriceChange(inputs, rules, first.states);
  assert.equal(repeated.output.matched, false);
  assert.deepEqual(repeated.output.messages, []);
  assert.equal(repeated.output.fields.rules.drop_5m.status, "active");
});

test("Binance price rules rearm, apply liquidity filters, and detect config changes", () => {
  const falling = binancePriceInputs(["100", "100", "100", "96", "94", "90"]);
  const rule = [{
    id: "drop_5m",
    window_minutes: 5,
    direction: "down" as const,
    threshold_percent: 8,
    rearm_percent: 6,
  }];
  const first = evaluateSpotPriceChange(falling, rule);

  const recovered = evaluateSpotPriceChange(
    binancePriceInputs(["100", "100", "100", "100", "100", "99"]),
    rule,
    first.states,
  );
  assert.equal(recovered.output.matched, false);
  assert.deepEqual(recovered.output.fields.activeRuleIds, []);

  const triggeredAgain = evaluateSpotPriceChange(falling, rule, recovered.states);
  assert.equal(triggeredAgain.output.matched, true);

  const filtered = evaluateSpotPriceChange(falling, [{
    ...rule[0],
    min_quote_volume: 10_000,
  }]);
  assert.equal(filtered.output.matched, false);
  assert.equal(filtered.output.fields.rules.drop_5m.priceMatched, true);
  assert.equal(filtered.output.fields.rules.drop_5m.filtersMatched, false);

  const reconfigured = evaluateSpotPriceChange(falling, [{
    ...rule[0],
    threshold_percent: 9,
  }], first.states);
  assert.equal(reconfigured.output.matched, true);
  assert.equal(reconfigured.output.fields.rules.drop_5m.newlyTriggered, true);
});

test("AlertPolicy produces multiple AlertMessages without knowing Destinations", async () => {
  const matched = await evaluateMatchedOutput(
    {
      matched: true,
      messages: [
        {
          title: "Aave health warning",
          description: "Ethereum is below its health-factor threshold",
          fields: { market: "Ethereum Core" },
        },
        {
          title: "Aave health warning",
          description: "Base is below its health-factor threshold",
          fields: { market: "Base Core" },
        },
      ],
      fields: { protocol: "aave-v3" },
    },
    "critical",
  );
  assert.deepEqual(matched, {
    messages: [
      {
        title: "Aave health warning",
        description: "Ethereum is below its health-factor threshold",
        severity: "critical",
        fields: { protocol: "aave-v3", market: "Ethereum Core" },
      },
      {
        title: "Aave health warning",
        description: "Base is below its health-factor threshold",
        severity: "critical",
        fields: { protocol: "aave-v3", market: "Base Core" },
      },
    ],
  });
  assert.equal("destination" in matched, false);

  const healthy = await evaluateMatchedOutput(
    { matched: false, messages: [], fields: {} },
  );
  assert.deepEqual(healthy, { messages: [] });
});

test("Root Flows pass all AlertPolicy messages to batch Destinations", () => {
  const paths = [
    "../u/oneke/binance_btcusdt_price_monitor__flow/flow.yaml",
    "../u/oneke/0x166Ce42Df5f4BAA94aBC5B62C60dab1B3C73D2a3/aave_v3_hf_monitor__flow/flow.yaml",
    "../u/oneke/0x166Ce42Df5f4BAA94aBC5B62C60dab1B3C73D2a3/aave_v4_hf_monitor__flow/flow.yaml",
    "../u/oneke/0x166Ce42Df5f4BAA94aBC5B62C60dab1B3C73D2a3/morpho_hf_monitor__flow/flow.yaml",
  ];
  for (const path of paths) {
    const flow = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(flow, /type: forloopflow/);
    assert.match(flow, /messages:\n\s+type: javascript\n\s+expr: results\.alert_policy\.messages/);
    assert.doesNotMatch(flow, /flow_input\.iter/);
    assert.doesNotMatch(flow, /results\.alert_policy\.message\b/);
  }
});

test("Destination Senders consume AlertMessage batches", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL | RequestInfo, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  const message = {
    title: "Aave health warning",
    description: "Health factor is below threshold",
    severity: "critical" as const,
    fields: { market: "Ethereum Core", healthFactor: "1.04" },
  };
  try {
    await sendTelegram({ token: "telegram-token" }, "123", [message, message]);
    await sendWebhook(
      { base_url: "https://alerts.example.test/api/" },
      "events",
      [message],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://api.telegram.org/bottelegram-token/sendMessage");
  assert.match((calls[0].body as { text: string }).text, /Aave health warning/);
  assert.equal(calls[2].url, "https://alerts.example.test/api/events");
  assert.deepEqual(calls[2].body, message);
});

test("Destination Senders return immediately when message is empty", async () => {
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
    assert.equal(await sendTelegram({ token: "" }, "", []), undefined);
    assert.equal(await sendWebhook({ base_url: "" }, "", undefined), undefined);
    assert.equal(await sendFlashduty({ url: "", integration_key: "" }, null), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false);
});

test("Destination batches are bounded", async () => {
  const message = {
    title: "x", description: "x", severity: "warning" as const, fields: {},
  };
  await assert.rejects(
    sendTelegram({ token: "test-only" }, "test-only", Array(101).fill(message)),
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
