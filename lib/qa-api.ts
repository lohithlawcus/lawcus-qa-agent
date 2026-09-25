// The one place the workspace talks to the local QA service. Every request
// carries the workspace header and the session cookie; a 401 opens a fresh
// session once and retries. Errors keep the server's message and, when it sent
// one, its machine-readable `code` (for example "lower_authority").

export const API = "http://127.0.0.1:4319";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function request<T = Record<string, string>>(
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const res = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      "X-QA-Client": "lawcus-workspace",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await res.json();
  if (res.status === 401 && retry) {
    await request("/session", {}, false);
    return request<T>(path, body, false);
  }
  if (!res.ok) {
    const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    throw new ApiError(
      typeof record.error === "string" ? record.error : "The request could not be completed.",
      res.status,
      typeof record.code === "string" ? record.code : undefined,
    );
  }
  return data as T;
}
