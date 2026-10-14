import assert from "node:assert/strict";
import test from "node:test";
import jsonpatch from "fast-json-patch";
import { jsondiff, type JsonObject } from "../f/chain_sentinel/lib/jsondiff.ts";

test("equal JSON objects ignore property insertion order", () => {
  assert.deepEqual(jsondiff({ a: 1, b: { x: true, y: [] } }, { b: { y: [], x: true }, a: 1 }), []);
});

test("add, remove and replace retain null and distinguish absent fields", () => {
  const patch = jsondiff({ removed: null, modified: 100 }, { added: null, modified: "100" });
  assert.deepEqual(patch.find(op => op.path === "/removed"), { op: "remove", path: "/removed", oldValue: null });
  assert.deepEqual(patch.find(op => op.path === "/modified"), { op: "replace", path: "/modified", value: "100", oldValue: 100 });
  assert.deepEqual(patch.find(op => op.path === "/added"), { op: "add", path: "/added", value: null });
  assert.deepEqual(jsonpatch.applyPatch({ removed: null, modified: 100 }, patch, true).newDocument, { added: null, modified: "100" });
});

test("removed and replaced containers preserve their complete old values", () => {
  const removed = { nested: { items: [null, { enabled: false }] }, empty: {} };
  const before = { removed, replaced: [1, { cap: 200 }] };
  const patch = jsondiff(before, { replaced: { enabled: true } });
  assert.deepEqual(patch.find(op => op.path === "/removed"), { op: "remove", path: "/removed", oldValue: removed });
  assert.deepEqual(patch.find(op => op.path === "/replaced"), {
    op: "replace", path: "/replaced", oldValue: [1, { cap: 200 }], value: { enabled: true },
  });
});

test("JSON Pointer escapes slash, tilde and empty property names", () => {
  const before = { "a/b": { "~key": { "": 1 } } };
  const after = { "a/b": { "~key": { "": 2 } } };
  const patch = jsondiff(before, after);
  assert.deepEqual(patch, [{ op: "replace", path: "/a~1b/~0key/", value: 2, oldValue: 1 }]);
  assert.deepEqual(jsonpatch.applyPatch(structuredClone(before), patch, true).newDocument, after);
});

test("array operations preserve valid sequential indices and old values", () => {
  for (const [before, after] of [
    [{ list: [1, 2, 3, 4] }, { list: [9] }],
    [{ list: [1] }, { list: [0, 1, 2] }],
    [{ list: [{ id: "a" }, { id: "b" }] }, { list: [{ id: "b" }, { id: "a" }] }],
    [{ list: [] }, { list: [{ nested: [1, 2] }] }],
    [{ list: [{ nested: [1, 2] }] }, { list: [] }],
  ] satisfies [JsonObject, JsonObject][]) {
    const patch = jsondiff(before, after);
    let current = structuredClone(before);
    for (const operation of patch) {
      if (operation.op !== "add") assert.deepEqual(operation.oldValue, jsonpatch.getValueByPointer(current, operation.path));
      current = jsonpatch.applyOperation(current, operation, true).newDocument;
    }
    assert.deepEqual(current, after);
  }
});

test("inputs and nested patch values do not share mutable references", () => {
  const before = { removed: { items: [1, 2] } };
  const after = { added: { items: [3, 4] } };
  const saved = structuredClone({ before, after });
  const patch = jsondiff(before, after);
  assert.deepEqual({ before, after }, saved);
  before.removed.items.push(5);
  after.added.items.push(6);
  assert.deepEqual(patch.find(op => op.op === "remove")?.oldValue, saved.before.removed);
  assert.deepEqual(patch.find(op => op.op === "add")?.value, saved.after.added);
});

test("invalid runtime inputs fail instead of being silently normalized", () => {
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), new Map(), [undefined], Array(1)]) {
    // @ts-expect-error Invalid JSON supplied by an untyped external caller.
    assert.throws(() => jsondiff({ bad: value }, {}), /JSON|plain/);
    // @ts-expect-error Invalid JSON supplied by an untyped external caller.
    assert.throws(() => jsondiff({}, { bad: value }), /JSON|plain/);
  }
  const circular: JsonObject = {};
  circular.self = circular;
  assert.throws(() => jsondiff(circular, {}), /Circular JSON value at before\/self/);
  // @ts-expect-error Root inputs are JSON objects.
  assert.throws(() => jsondiff(null, {}), /before must be a JSON object/);
  // @ts-expect-error Root inputs are JSON objects.
  assert.throws(() => jsondiff({}, []), /after must be a JSON object/);
});

test("shared subobjects are valid JSON without being mistaken for cycles", () => {
  const shared = { value: 1 };
  const before = { a: shared, b: shared };
  const after = { a: { value: 2 }, b: { value: 1 } };
  assert.deepEqual(jsondiff(before, after), [{ op: "replace", path: "/a/value", value: 2, oldValue: 1 }]);
});
