import { ProxyAgent, fetch as undiciFetch } from "undici";
import { startEgress } from "./egress.mjs";
import { validateShape, validateResponseAgainstContract } from "./schema-shape.mjs";

// V5 Step 10 / section 22 — Safe API Executor. The only way anything in
// this codebase may make a real, direct (non-browser) HTTP call to a
// Lawcus environment. Every call must resolve BOTH an approved API
// contract (what the endpoint should do) AND an approved Environment
// Adapter + Network Authority (where it lives / whether it may be
// contacted at all) — section 21: an approved contract never by itself
// grants permission to contact anything. This is never exposed as a raw
// fetch(): there is no code path here that accepts an arbitrary URL.

const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 200_000;
const MAX_REQUEST_BYTES = 20_000;

export class ApiClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fillPath(template, pathParams) {
  return template.replace(/:([a-zA-Z0-9_]+)/g, (match, key) => {
    if (!(key in pathParams))
      throw new ApiClientError("missing_path_param", `Path parameter "${key}" was not provided.`);
    return encodeURIComponent(String(pathParams[key]));
  });
}

// Records only shape/metadata, never a value — section 22: "Do not log raw
// authorization values." Applies to both the outgoing request and the
// response we received, regardless of which field the sensitive value was
// under.
function summarizeBody(value) {
  if (value === null || value === undefined) return { present: false };
  if (Array.isArray(value)) return { present: true, kind: "array", length: value.length };
  if (typeof value === "object") return { present: true, kind: "object", keys: Object.keys(value).sort() };
  if (typeof value === "string") return { present: true, kind: "string", length: value.length };
  return { present: true, kind: typeof value };
}

export function createSafeApiClient({ environmentAdapter, networkAuthority, apiContracts }) {
  async function execute({
    environmentId,
    semanticId,
    pathParams = {},
    query = {},
    requestBody = null,
    runId = null,
  }) {
    const started = Date.now();
    // Normalized to ApiClientError so every caller of the executor deals
    // with exactly one error type, regardless of which underlying
    // registry (contract / adapter / authority) refused the call.
    const resolve = (fn, fallbackCode) => {
      try {
        return fn();
      } catch (error) {
        throw new ApiClientError(error.code || fallbackCode, error.message);
      }
    };
    const contract = resolve(() => apiContracts.resolveApprovedContract(semanticId), "no_approved_contract");
    const adapter = resolve(() => environmentAdapter.resolveApprovedAdapter(environmentId), "no_approved_adapter");
    const authority = resolve(() => networkAuthority.resolveApprovedAuthority(environmentId), "no_approved_authority");

    if (!authority.allowedMethods.includes(contract.method))
      throw new ApiClientError(
        "method_not_authorized",
        `Network Authority does not permit ${contract.method} for "${environmentId}".`,
      );
    let origin;
    try {
      origin = new URL(adapter.api_origin);
    } catch {
      throw new ApiClientError("invalid_adapter", "The Environment Adapter's API origin is invalid.");
    }
    if (origin.protocol !== "https:")
      throw new ApiClientError("tls_required", "The Safe API Executor only contacts https origins.");
    if (!authority.allowedHosts.includes(origin.hostname))
      throw new ApiClientError(
        "host_not_authorized",
        `Network Authority does not permit contacting "${origin.hostname}".`,
      );

    if (contract.requestSchema) {
      const errors = validateShape(contract.requestSchema, requestBody ?? {});
      if (errors.length)
        throw new ApiClientError(
          "request_contract_mismatch",
          `The outgoing request does not match the approved contract: ${errors.join("; ")}`,
        );
    }
    const bodyText = requestBody === null ? null : JSON.stringify(requestBody);
    if (bodyText && Buffer.byteLength(bodyText) > MAX_REQUEST_BYTES)
      throw new ApiClientError("request_too_large", "The request body exceeds the allowed size.");

    const path = fillPath(contract.path_template, pathParams);
    const search = new URLSearchParams(query).toString();
    const url = `${origin.origin}${path}${search ? `?${search}` : ""}`;

    let proxy;
    let responseStatus = null;
    let responseBody = null;
    let responseSummary = null;
    let mismatchReason = null;
    try {
      proxy = await startEgress([origin.hostname]);
      const dispatcher = new ProxyAgent({ uri: proxy.server });
      let response;
      try {
        response = await undiciFetch(url, {
          method: contract.method,
          headers: {
            ...(bodyText ? { "content-type": "application/json" } : {}),
            accept: "application/json",
          },
          body: bodyText ?? undefined,
          redirect: "manual",
          dispatcher,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new ApiClientError(
          "network_error",
          `The authorized network boundary could not complete this request: ${error.message}`,
        );
      }
      // Redirects are never followed or trusted in this version — section
      // 21: "redirect escape blocked" — regardless of what a future
      // Network Authority's allow_redirects field might record.
      if (response.status >= 300 && response.status < 400)
        throw new ApiClientError("redirect_blocked", "The response attempted a redirect; this is blocked.");
      responseStatus = response.status;
      const reader = response.body?.getReader();
      let raw = "";
      let size = 0;
      if (reader) {
        const decoder = new TextDecoder();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_RESPONSE_BYTES)
              throw new ApiClientError("response_too_large", "The response exceeded the allowed size.");
            raw += decoder.decode(chunk.value, { stream: true });
          }
          raw += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("json") && raw) {
        try {
          responseBody = JSON.parse(raw);
        } catch {
          throw new ApiClientError("invalid_response", "The response declared JSON but did not parse as JSON.");
        }
      } else {
        responseBody = raw || null;
      }
      responseSummary = summarizeBody(responseBody);

      const statusOk = contract.expectedStatuses.includes(responseStatus);
      const shapeErrors = validateResponseAgainstContract(contract.responseSchema, responseStatus, responseBody);
      if (!statusOk) mismatchReason = `Unexpected status ${responseStatus}; expected one of ${contract.expectedStatuses.join(", ")}.`;
      else if (shapeErrors.length) mismatchReason = `Response shape drift: ${shapeErrors.join("; ")}`;

      const contractMatch = statusOk && shapeErrors.length === 0;
      apiContracts.recordCall({
        contractId: contract.id,
        environmentId,
        runId,
        requestSummary: { method: contract.method, host: origin.hostname, path, body: summarizeBody(requestBody) },
        responseStatus,
        responseSummary,
        contractMatch,
        mismatchReason,
        durationMs: Date.now() - started,
      });
      return { status: responseStatus, body: responseBody, contractMatch, mismatchReason, contract };
    } catch (error) {
      // A failure that reached the network boundary is still evidence
      // (section 22: sanitized API evidence) — it's just evidence of a
      // call that never produced a conforming response, not evidence that
      // gets silently discarded.
      if (error instanceof ApiClientError)
        apiContracts.recordCall({
          contractId: contract.id,
          environmentId,
          runId,
          requestSummary: { method: contract.method, host: origin.hostname, path, body: summarizeBody(requestBody) },
          responseStatus,
          responseSummary,
          contractMatch: false,
          mismatchReason: error.message,
          durationMs: Date.now() - started,
        });
      throw error;
    } finally {
      await proxy?.close().catch(() => {});
    }
  }

  return { execute };
}
