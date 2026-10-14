//native

import type { Baseline, Evaluation, NetworkParams, ParamChange, ParamValue, Snapshots } from "../../lib/market-params.ts";

// Compare enumerable arrays by entity identity so swap-and-pop/reordering does not alert.
// Dynamic configs have no embedded ID: their array index is the protocol version key.
const arrayIds: Record<string, string> = {
  assets: "assetId", registeredSpokes: "spoke", spokes: "addr", treasuries: "addr",
  tokenizations: "addr", otherSpokes: "addr", authorities: "addr", roles: "roleId",
  reserves: "reserveId", members: "account", targets: "target", knownTargets: "target", functions: "selector",
};
function entries(value: object | undefined, field: string | undefined): Record<string, ParamValue | object> {
  if (!Array.isArray(value)) return (value ?? {}) as Record<string, ParamValue | object>;
  const id = field ? arrayIds[field] : undefined;
  return Object.fromEntries(value.map((entry, index) => [id ? String(entry[id]) : String(index), entry]));
}

function compareNetwork(chain_id: number, before: NetworkParams | undefined, after: NetworkParams) {
  const changes: ParamChange[] = [];
  let observed = 0;
  const isObject = (value: unknown): value is object => value !== null && typeof value === "object";
  function visit(old: object | undefined, current: object | undefined, path: string[], name: string) {
    // Type erasure belongs to the report boundary; protocol fields remain independently typed.
    const oldFields = entries(old, path.at(-1));
    const currentFields = entries(current, path.at(-1));
    const keys = [...new Set([...Object.keys(oldFields), ...Object.keys(currentFields)])].sort();
    if (path.length === 1) name = `Hub (${path[0]})`;
    const fields: ParamChange["fields"] = [];
    for (const parameter of keys) {
      const a = oldFields?.[parameter], b = currentFields?.[parameter];
      if (isObject(a) || isObject(b)) {
        visit(a as object | undefined, b as object | undefined, [...path, parameter], `${name} / ${parameter}`);
      } else if (!old || !current || a !== b) {
        fields.push({ parameter, before: (a ?? null) as ParamValue, after: (b ?? null) as ParamValue });
      }
    }
    if (current && Object.values(current).some((value) => !isObject(value))) observed++;
    if (fields.length) changes.push({
      chain_id, path: [String(chain_id), ...path].join("."), name,
      change: !old ? "added" : !current ? "removed" : "updated", fields
    });
  }
  visit(before, after, [], `Chain ${chain_id}`);
  return { changes, observed };
}

export async function main(current: Snapshots, previous: Baseline | null = null): Promise<Evaluation> {
  const nextBaseline = structuredClone(previous ?? {});
  const changes: ParamChange[] = [];
  let observed_objects = 0;
  for (const chain of Object.keys(current).sort((a, b) => Number(a) - Number(b))) {
    const snapshot = current[chain];
    const compared = compareNetwork(Number(chain), previous?.[chain], snapshot);
    if (previous !== null) changes.push(...compared.changes);
    observed_objects += compared.observed;
    // Only observed networks replace their baseline; omitted networks are not deletions.
    nextBaseline[chain] = structuredClone(snapshot);
  }
  changes.sort((a, b) => a.chain_id - b.chain_id || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const messages = [...new Set(changes.map((change) => change.chain_id))].map((chain_id) => {
    const selected = changes.filter((change) => change.chain_id === chain_id);
    let description = `Chain: ${chain_id}\nChanged objects: ${selected.length}\n`;
    let omitted = 0;
    for (const change of selected) {
      const text = `\n${change.change}: ${change.name}\nPath: ${change.path}\n`
        + change.fields.map((field) => `${field.parameter}: ${field.before ?? "unset"} → ${field.after ?? "unset"}`).join("\n") + "\n";
      if (description.length + text.length <= 2800) description += text;
      else omitted++;
    }
    if (omitted) description += `\n${omitted} more objects; full changes are in the Windmill job result.`;
    return {
      title: `Aave V4 market params changed (${chain_id})`, description,
      fields: { chain_id, finding_kind: "market_params_change" as const }
    };
  });
  return {
    nextBaseline,
    output: { matched: changes.length > 0, messages, fields: { changes, observed_objects, message_count: messages.length } },
  };
}
