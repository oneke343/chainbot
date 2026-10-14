import assert from "node:assert/strict";
import test from "node:test";
import { jsondiff, renderJsonDiff, type JsonDiffOperation } from "../f/chain_sentinel/lib/jsondiff.ts";

test("renderer groups changes by parent and reports all operation counts", () => {
  const patch: JsonDiffOperation[] = [
    { op: "replace", path: "/config/cap", value: 200, oldValue: 100 },
    { op: "add", path: "/enabled", value: true },
    { op: "replace", path: "/config/paused", value: true, oldValue: false },
    { op: "remove", path: "/config/legacy", oldValue: null },
  ];
  assert.equal(renderJsonDiff(patch), [
    "检测到 4 项变化：修改 2，新增 1，删除 1", "", "/config",
    "  修改 cap：100 → 200", "  修改 paused：false → true", "  删除 legacy：null",
    "", "(根对象)", "  新增 enabled：true",
  ].join("\n"));
});

test("renderer preserves scalar types and escapes unusual field names", () => {
  const rendered = renderJsonDiff([
    { op: "replace", path: "/a~1b/~0key", oldValue: 100, value: "100" },
    { op: "add", path: "/", value: null },
    { op: "remove", path: "/a.b", oldValue: false },
    { op: "add", path: "/line\nbreak", value: "value\nnext" },
  ]);
  assert.ok(rendered.includes('/a~1b\n  修改 "~key"：100 → "100"'));
  assert.ok(rendered.includes('  新增 ""：null'));
  assert.ok(rendered.includes('  删除 "a.b"：false'));
  assert.ok(rendered.includes('  新增 "line\\nbreak"："value\\nnext"'));
});

test("renderer distinguishes root from an empty-name parent and preserves array indices", () => {
  const rendered = renderJsonDiff([
    { op: "add", path: "/enabled", value: true },
    { op: "add", path: "//enabled", value: false },
    { op: "replace", path: "/assets/0/cap", value: 200, oldValue: 100 },
  ]);
  assert.ok(rendered.includes("\n\n(根对象)\n  新增 enabled：true"));
  assert.ok(rendered.includes("\n\n/\n  新增 enabled：false"));
  assert.ok(rendered.includes("\n\n/assets/0\n  修改 cap：100 → 200"));
});

test("renderer formats added, removed and replaced containers as indented JSON", () => {
  const rendered = renderJsonDiff([
    { op: "remove", path: "/config", oldValue: { paused: false, items: [1, 2] } },
    { op: "add", path: "/empty", value: {} },
    { op: "replace", path: "/list", oldValue: [], value: { enabled: true } },
  ]);
  assert.ok(rendered.includes('  删除 config：\n    {\n      "paused": false,'));
  assert.ok(rendered.includes("  新增 empty：\n    {}"));
  assert.ok(rendered.includes('  修改 list：\n    旧值：\n      []\n    新值：\n      {\n        "enabled": true\n      }'));
});

test("renderer reports no changes and works directly with jsondiff output", () => {
  assert.equal(renderJsonDiff([]), "未检测到变化");
  assert.equal(renderJsonDiff(jsondiff({ config: { cap: 100 } }, { config: { cap: 200 } })),
    "检测到 1 项变化：修改 1，新增 0，删除 0\n\n/config\n  修改 cap：100 → 200");
});

test("renderer bounds item count and preserves the full immutable patch", () => {
  const patch: JsonDiffOperation[] = Array.from({ length: 25 }, (_, index) => ({ op: "add", path: `/config/key${index}`, value: index }));
  const before = structuredClone(patch);
  const rendered = renderJsonDiff(patch, { maxChanges: 2 });
  assert.ok(rendered.startsWith("检测到 25 项变化：修改 0，新增 25，删除 0"));
  assert.ok(rendered.includes("  新增 key1：1"));
  assert.ok(!rendered.includes("  新增 key2：2"));
  assert.ok(rendered.endsWith("另有 23 项变化未展示；完整内容请查看原始 Patch。"));
  assert.deepEqual(patch, before);
});

test("renderer bounds total characters including omission notice and large paths", () => {
  const patch: JsonDiffOperation[] = Array.from({ length: 50 }, (_, index) => ({ op: "add", path: `/config/key${index}`, value: "x".repeat(60) }));
  const rendered = renderJsonDiff(patch, { maxChars: 180 });
  assert.ok(rendered.length <= 180);
  assert.match(rendered, /另有 \d+ 项变化未展示/);
  const hugePath = renderJsonDiff([{ op: "add", path: `/${"p".repeat(1000)}/key`, value: 1 }], { maxChars: 128 });
  assert.ok(hugePath.length <= 128);
  assert.ok(hugePath.endsWith("另有 1 项变化未展示；完整内容请查看原始 Patch。"));
});

test("renderer marks truncated values without splitting surrogate pairs", () => {
  const patch = [{ op: "add", path: "/value", value: "😀".repeat(1000) }] satisfies JsonDiffOperation[];
  const rendered = renderJsonDiff(patch, { maxValueChars: 32 });
  assert.ok(rendered.includes("(内容已截断)"));
  assert.ok(!rendered.includes("�"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rendered));
  assert.equal(patch[0].value, "😀".repeat(1000));
});

test("renderer rejects invalid limits and malformed JSON Pointers", () => {
  for (const options of [{ maxChanges: 0 }, { maxChanges: 1.5 }, { maxChars: 127 }, { maxValueChars: 31 }, { maxChars: NaN }]) {
    assert.throws(() => renderJsonDiff([], options), /must be an integer/);
  }
  for (const path of ["config/cap", "/config/~2key"]) {
    assert.throws(() => renderJsonDiff([{ op: "add", path, value: 1 }]), /Invalid JSON Pointer/);
  }
});

test("renderer handles root replacement and escapes control characters in parent paths", () => {
  const rendered = renderJsonDiff([
    { op: "replace", path: "", oldValue: { enabled: false }, value: null },
    { op: "add", path: "/line\nbreak/enabled", value: true },
  ]);
  assert.ok(rendered.includes("(根对象)\n  修改 (根值)：\n    旧值："));
  assert.ok(rendered.includes("    新值：\n      null"));
  assert.ok(rendered.includes('"/line\\nbreak"\n  新增 enabled：true'));
});

test("renderer rejects missing old values and operations outside the diff contract", () => {
  // @ts-expect-error External data is missing the required oldValue extension.
  assert.throws(() => renderJsonDiff([{ op: "remove", path: "/config" }]), /Invalid JSON value at oldValue/);
  // @ts-expect-error The producer emits only add, remove and replace.
  assert.throws(() => renderJsonDiff([{ op: "test", path: "/config", value: 1 }]), /Unsupported diff operation/);
});
