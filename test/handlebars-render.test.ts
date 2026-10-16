import assert from "node:assert/strict";
import test from "node:test";
import Handlebars from "handlebars";
import { main as render } from "../f/handlebars/render.ts";

test("renderer supports equality conditions and loops without global helper changes", async () => {
  const context = {
    patch: [
      { op: "add", path: "/cap", value: 0 },
      { op: "remove", path: "/enabled", oldValue: false },
    ],
  };
  const before = structuredClone(context);
  const originalEq = Handlebars.helpers.eq;
  const template =
    '{{#each patch}}{{#if (eq op "add")}}Added {{path}}: {{value}}{{else}}Removed {{path}}: {{oldValue}}{{/if}}\n{{/each}}';
  assert.equal(
    await render(template, context),
    "Added /cap: 0\nRemoved /enabled: false\n",
  );
  assert.deepEqual(context, before);
  assert.equal(Handlebars.helpers.eq, originalEq);
});

test("renderer preserves plain text instead of HTML escaping", async () => {
  assert.equal(
    await render("{{description}}", {
      description: "cap < 100 & owner > limit",
    }),
    "cap < 100 & owner > limit",
  );
});

test("missing fields and malformed templates fail explicitly", async () => {
  await assert.rejects(render("{{missing}}", {}), /not defined/);
  await assert.rejects(render("{{#each patch}}", { patch: [] }), /Parse error/);
});

test("numeric helpers group amounts and distinguish percentages from percentage points", async () => {
  const context = {
    amount: "1234567.890123456789",
    rate: "0.07006912",
    change: "0.02005678",
    tiny: "0.000000000123456",
    zero: "0",
    negative: "-0.20000123",
  };
  const before = structuredClone(context);
  assert.equal(
    await render(
      "{{number amount}} | {{percent rate}} | {{pp change}} | {{number tiny}} | {{number zero}} | {{percent negative}}",
      context,
    ),
    "1,234,567.8901 | 7.01% | 2.01 pp | 1.23e-10 | 0 | -20%",
  );
  assert.deepEqual(context, before);
});
