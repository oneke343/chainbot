//native

export type RenderMessageContext = {
  inputs: Record<string, unknown>;
  states: Record<string, unknown>;
};

const PLACEHOLDER = /{{\s*((?:inputs|states)(?:\.[A-Za-z0-9_-]+)*)\s*}}/g;

function resolvePath(context: RenderMessageContext, path: string): unknown {
  let value: unknown = context;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatValue).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value == null ? "" : String(value);
}

export function renderMessage(template: string, context: RenderMessageContext): string {
  if (!template.trim()) throw new Error("message template is required");

  return template.replace(PLACEHOLDER, (_, path: string) => {
    const value = resolvePath(context, path);
    if (value === undefined) throw new Error(`message template value not found: ${path}`);
    return formatValue(value);
  });
}
