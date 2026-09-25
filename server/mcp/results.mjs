import { McpToolError } from "./tools.mjs";
import { redactValue, safeErrorMessage } from "../core/redact.mjs";

// What the MCP server returns to a caller. Credential-looking text is masked
// before it leaves the process: a run's stored explanation or an unexpected
// error's message can quote something a browser or a request echoed back.
// Values are masked (not key names), so legitimate result fields such as an
// API contract's header list survive.
export function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(redactValue(value, { maskKeys: false }), null, 2) }] };
}

export function errorResult(error) {
  if (error instanceof McpToolError)
    return { content: [{ type: "text", text: JSON.stringify({ error: error.code, message: safeErrorMessage(error) }) }], isError: true };
  // An unexpected error is reported, never silently swallowed — with its
  // message masked, because native runners do read real credentials.
  return { content: [{ type: "text", text: JSON.stringify({ error: "internal_error", message: safeErrorMessage(error) }) }], isError: true };
}
