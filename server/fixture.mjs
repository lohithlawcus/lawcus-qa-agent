import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export function startFixture(port = 4320) {
  const sessions = new Set();
  const state = { label: "Sign in", acceptInvalid: false };
  const page = (body) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>QA fixture · Login</title><style>body{font:18px system-ui;background:#eaf0f6;color:#17253b;display:grid;place-items:center;min-height:90vh}main{background:white;border:1px solid #c4d2e0;border-radius:16px;padding:40px;width:360px}label{display:block;margin:18px 0 8px}input,button{font:inherit;box-sizing:border-box;width:100%;padding:12px}button{margin-top:24px;background:#224dce;color:white;border:0;border-radius:6px}small{color:#586b80}a{color:#234bbf}</style></head><body><main><small>LOCAL SYNTHETIC TEST APPLICATION</small>${body}</main></body></html>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const token = /fixture_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (req.method === "POST" && ["/login", "/logout"].includes(url.pathname)) {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) {
          res.writeHead(413);
          res.end();
          return;
        }
      }
      if (url.pathname === "/logout") {
        sessions.delete(token);
        res.setHeader(
          "Set-Cookie",
          "fixture_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        res.writeHead(303, { Location: "/login" });
        res.end();
        return;
      }
      const form = new URLSearchParams(body);
      if (
        form.get("email") === "qa@example.test" &&
        (form.get("password") === "Fixture-only-123!" || state.acceptInvalid)
      ) {
        const id = randomUUID();
        sessions.add(id);
        res.setHeader(
          "Set-Cookie",
          `fixture_session=${id}; HttpOnly; SameSite=Strict; Path=/`,
        );
        res.writeHead(303, { Location: "/workspace" });
        res.end();
        return;
      }
      res.writeHead(303, { Location: "/login?error=1" });
      res.end();
      return;
    }
    if (url.pathname === "/workspace") {
      if (!sessions.has(token)) {
        res.writeHead(303, { Location: "/login" });
        res.end();
        return;
      }
      res.end(
        page(
          '<h1>Welcome, QA user</h1><p>You are signed in to the synthetic workspace.</p><form method="post" action="/logout"><button>Sign out</button></form>',
        ),
      );
      return;
    }
    if (url.pathname === "/" || url.pathname === "/login") {
      res.end(
        page(
          `<h1>Sign in to your workspace</h1>${url.searchParams.has("error") ? '<p role="alert">Invalid email or password</p>' : ""}<form method="post" action="/login"><label for="email">Email address</label><input type="email" id="email" name="email" required autocomplete="off"><label for="password">Password</label><input type="password" id="password" name="password" required autocomplete="off"><button>${state.label}</button></form>`,
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        server,
        state,
        origin: `http://127.0.0.1:${server.address().port}`,
      }),
    );
  });
}
