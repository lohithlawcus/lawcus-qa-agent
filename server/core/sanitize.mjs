// Shared by api-client.mjs (Step 10) and network-observer.mjs (Step 11):
// every place that records real request/response evidence must summarize a
// body the same way — keys/shape only, never a value. Section 22: "Do not
// log raw authorization values" applies just as much to a captured browser
// request as to one the Safe API Executor made itself.
export function summarizeBody(value) {
  if (value === null || value === undefined) return { present: false };
  if (Array.isArray(value)) return { present: true, kind: "array", length: value.length };
  if (typeof value === "object") return { present: true, kind: "object", keys: Object.keys(value).sort() };
  if (typeof value === "string") return { present: true, kind: "string", length: value.length };
  return { present: true, kind: typeof value };
}
