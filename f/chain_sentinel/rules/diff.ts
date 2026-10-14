//native

import { jsondiff, type JsonObject, type JsonDiffOperation } from "../lib/jsondiff.ts";

export async function main(before: JsonObject, after: JsonObject): Promise<JsonDiffOperation[]> {
  return jsondiff(before, after);
}
