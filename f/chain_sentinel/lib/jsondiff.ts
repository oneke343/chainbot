//native

import jsonpatch, { type AddOperation, type RemoveOperation, type ReplaceOperation, type TestOperation } from "fast-json-patch";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type JsonDiffOperation = AddOperation<JsonValue>
  | (RemoveOperation & { oldValue: JsonValue })
  | (ReplaceOperation<JsonValue> & { oldValue: JsonValue });

function validateJson(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) throw new Error(`Invalid JSON value at ${path}`);
  if (ancestors.has(value)) throw new Error(`Circular JSON value at ${path}`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`Expected a plain JSON object at ${path}`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) validateJson(value[index], `${path}/${index}`, ancestors);
  } else {
    for (const [key, item] of Object.entries(value)) {
      validateJson(item, `${path}/${jsonpatch.escapePathComponent(key)}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/**
 * Compare JSON objects without mutating them. Arrays are compared by index.
 * remove/replace retain the complete prior value; add has no oldValue.
 * The result remains an applicable JSON Patch with oldValue as an extension.
 */
export function jsondiff(before: JsonObject, after: JsonObject): JsonDiffOperation[] {
  for (const [name, document] of Object.entries({ before, after })) {
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error(`${name} must be a JSON object`);
    }
    validateJson(document, name);
  }
  const result: JsonDiffOperation[] = [];
  let prior: TestOperation<JsonValue> | undefined;
  // Invertible comparison emits a cloned old value in a test immediately
  // before each remove/replace, preserving array operation order.
  for (const operation of jsonpatch.compare(before, after, true)) {
    switch (operation.op) {
      case "test":
        prior = operation;
        break;
      case "add":
        result.push(operation);
        prior = undefined;
        break;
      case "remove":
      case "replace":
        if (!prior || prior.path !== operation.path) throw new Error(`Missing old value at ${operation.path}`);
        result.push({ ...operation, oldValue: prior.value });
        prior = undefined;
        break;
      default:
        throw new Error(`Unexpected comparison operation: ${operation.op}`);
    }
  }
  return result;
}

export type RenderJsonDiffOptions = {
  maxChanges?: number;
  maxChars?: number;
  maxValueChars?: number;
};

/** Render a grouped plain-text alert. Limits affect display only, not the patch. */
export function renderJsonDiff(patch: readonly JsonDiffOperation[], options: RenderJsonDiffOptions = {}): string {
  const maxChanges = options.maxChanges ?? 20;
  const maxChars = options.maxChars ?? 2800;
  const maxValueChars = options.maxValueChars ?? 300;
  for (const [name, value, minimum] of [
    ["maxChanges", maxChanges, 1], ["maxChars", maxChars, 128], ["maxValueChars", maxValueChars, 32],
  ] satisfies [string, number, number][]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  if (!patch.length) return "未检测到变化";

  const counts = { replace: 0, add: 0, remove: 0 };
  const groups = new Map<string, Array<{ field: string; operation: JsonDiffOperation }>>();
  for (const operation of patch) {
    if (operation.op !== "add" && operation.op !== "remove" && operation.op !== "replace") {
      throw new Error("Unsupported diff operation; expected add, remove or replace");
    }
    if (typeof operation.path !== "string" || (operation.path !== "" && !operation.path.startsWith("/")) || /~(?![01])/.test(operation.path)) {
      throw new Error(`Invalid JSON Pointer: ${operation.path}`);
    }
    if (operation.op !== "add") validateJson(operation.oldValue, `oldValue at ${operation.path}`);
    if (operation.op !== "remove") validateJson(operation.value, `value at ${operation.path}`);
    counts[operation.op]++;
    const slash = operation.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : operation.path.slice(0, slash);
    const key = jsonpatch.unescapePathComponent(operation.path.slice(slash + 1));
    const field = operation.path === "" ? "(根值)" : /^[\p{L}\p{N}_-]+$/u.test(key) ? key : JSON.stringify(key);
    const group = groups.get(parent) ?? [];
    group.push({ field, operation });
    groups.set(parent, group);
  }

  function formatValue(value: JsonValue): string {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxValueChars) return text;
    const marker = "…(内容已截断)";
    let end = maxValueChars - marker.length;
    // Character budgets use UTF-16, but truncation must keep Unicode pairs intact.
    if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    return text.slice(0, end) + marker;
  }
  const indent = (text: string, spaces: number) => text.split("\n").map(line => " ".repeat(spaces) + line).join("\n");
  const container = (value: JsonValue) => value !== null && typeof value === "object";
  function renderChange(field: string, operation: JsonDiffOperation): string {
    switch (operation.op) {
      case "add":
        return container(operation.value) ? `  新增 ${field}：\n${indent(formatValue(operation.value), 4)}`
          : `  新增 ${field}：${formatValue(operation.value)}`;
      case "remove":
        return container(operation.oldValue) ? `  删除 ${field}：\n${indent(formatValue(operation.oldValue), 4)}`
          : `  删除 ${field}：${formatValue(operation.oldValue)}`;
      case "replace":
        return container(operation.oldValue) || container(operation.value)
          ? `  修改 ${field}：\n    旧值：\n${indent(formatValue(operation.oldValue), 6)}\n    新值：\n${indent(formatValue(operation.value), 6)}`
          : `  修改 ${field}：${formatValue(operation.oldValue)} → ${formatValue(operation.value)}`;
    }
  }
  const omission = (remaining: number) => `\n\n另有 ${remaining} 项变化未展示；完整内容请查看原始 Patch。`;
  let text = `检测到 ${patch.length} 项变化：修改 ${counts.replace}，新增 ${counts.add}，删除 ${counts.remove}`;
  let shown = 0;
  display: for (const [parent, changes] of groups) {
    const label = parent === "" ? "(根对象)" : /[\u0000-\u001f\u007f]/.test(parent) ? JSON.stringify(parent) : parent;
    let first = true;
    for (const { field, operation } of changes) {
      if (shown >= maxChanges) break display;
      const entry = (first ? `\n\n${label}\n` : "\n") + renderChange(field, operation);
      const remaining = patch.length - shown - 1;
      const reserved = remaining ? omission(remaining).length : 0;
      if (text.length + entry.length + reserved > maxChars) break display;
      text += entry;
      shown++;
      first = false;
    }
  }
  if (shown < patch.length) text += omission(patch.length - shown);
  return text;
}
