import type { Json, JsonObject } from "./types.js";

/**
 * Canonical JSON for an approval argument object: object keys are sorted at
 * every depth, arrays keep their order, and scalars keep JSON encoding. This is
 * the exact string used as `argsKey` on `pi.approval-rule` journal entries, so
 * an API process and a worker process compute the same key.
 */
function canonicalJson(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const fields = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`,
    );
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic key for one tool call's arguments. Two argument objects that
 * are structurally equal (even with a different key insertion order) produce
 * the same key; any changed value produces a different one.
 */
export function approvalArgsKey(args: JsonObject): string {
  return canonicalJson(args);
}
