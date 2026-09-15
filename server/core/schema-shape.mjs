// V5 Step 10 — a small, dependency-free structural validator for API
// contract request/response schemas. Deliberately not a full JSON Schema
// implementation: contracts here only ever need type/required/properties/
// items/nullable, and a minimal, fully-understood validator is safer for a
// security-relevant boundary than pulling in a large general-purpose one.
// Unknown/extra properties are allowed (a contract asserts what it knows
// about, not a closed shape) — see section "API Contracts: response
// mismatch fails" — a *missing* required or *wrong-typed* field fails; an
// extra field a real API happens to also return does not.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateShape(schema, value, path = "$") {
  if (!schema || typeof schema !== "object") return [];
  const errors = [];
  if (value === null || value === undefined) {
    if (schema.nullable) return [];
    if (schema.type && schema.type !== "null")
      errors.push(`${path}: expected ${schema.type}, got ${value === null ? "null" : "undefined"}`);
    return errors;
  }
  if (schema.type) {
    const actual = typeOf(value);
    const okType =
      schema.type === actual ||
      (schema.type === "integer" && actual === "number" && Number.isInteger(value)) ||
      (schema.type === "number" && actual === "number");
    if (!okType) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
      return errors;
    }
  }
  if (schema.type === "object" || (!schema.type && typeOf(value) === "object")) {
    for (const key of schema.required || [])
      if (!(key in value)) errors.push(`${path}.${key}: required field is missing`);
    for (const [key, propSchema] of Object.entries(schema.properties || {}))
      if (key in value) errors.push(...validateShape(propSchema, value[key], `${path}.${key}`));
  }
  if (schema.type === "array" && schema.items)
    value.forEach((entry, i) => errors.push(...validateShape(schema.items, entry, `${path}[${i}]`)));
  return errors;
}

/** response_schema for an API contract is keyed by response status
 * ("200","400",...) plus an optional "default" — different statuses
 * legitimately return different shapes (e.g. success payload vs error
 * envelope). Falls back to "default", then passes with no assertions if
 * neither is present (nothing was actually observed/documented for that
 * status; failing closed here would invent a claim this contract doesn't
 * make). */
export function validateResponseAgainstContract(responseSchemaByStatus, status, body) {
  const schema = responseSchemaByStatus[String(status)] ?? responseSchemaByStatus.default;
  if (!schema) return [];
  return validateShape(schema, body);
}
