"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, KeyRound, CheckCircle2, LoaderCircle, Globe, LockKeyhole } from "lucide-react";

type Environment = { id: string; name: string; url: string; kind: string; execution_enabled: number };
type EnvironmentFacts = {
  staging: boolean;
  dedicatedAccountAvailable: boolean;
  mfa: boolean;
  sso: boolean;
  captcha: boolean;
};
type EnvironmentConfirmation = { environmentId: string; facts: EnvironmentFacts };
type Setup = {
  status?: string;
  ready?: boolean;
  loginConfigured: boolean;
  loginConfiguredByEnvironment?: Record<string, boolean>;
  aiConfigured: boolean;
  aiChoice?: { provider: string; model: string };
  aiProviders?: { id: string; label: string; configured: boolean; keyPage: string; defaultModel: string }[];
  storage: string;
};
const API = "http://127.0.0.1:4319";

// The same fixed list the service uses (server/ai/providers/catalog.mjs). It is shown even
// when the Keychain status cannot be read, so the picker always has its options; the
// "key saved" labels come from the status only.
const AI_PROVIDER_OPTIONS = [
  { id: "openai", label: "OpenAI", keyPage: "https://platform.openai.com/api-keys", defaultModel: "gpt-4.1-mini" },
  { id: "openrouter", label: "OpenRouter", keyPage: "https://openrouter.ai/keys", defaultModel: "google/gemma-4-31b-it:free" },
  { id: "anthropic", label: "Anthropic", keyPage: "https://console.anthropic.com/settings/keys", defaultModel: "claude-sonnet-4-5" },
];
async function call(
  path: string,
  body?: unknown,
  retry = true,
): Promise<Setup & { message?: string; error?: string }> {
  const r = await fetch(API + path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: { "X-QA-Client": "lawcus-workspace", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = (await r.json()) as Setup & { message?: string; error?: string };
  if (r.status === 401 && retry) {
    await call("/session", {}, false);
    return call(path, body, false);
  }
  if (!r.ok) throw new Error(d.error || "Setup could not be completed.");
  return d;
}

// V5 "add two more urls" (2026-09-17) — only Fiveriverz (id 'lawcus') has
// the interactive "sign in yourself, we verify and save it" flow, since
// connectInBrowser() still targets Fiveriverz's own fixed origin. The
// other three environments use the direct email/password save form only,
// same as Fiveriverz's own form always has — a real, current limitation,
// not hidden from the operator.
const INTERACTIVE_SIGNIN_ENVIRONMENT_ID = "lawcus";

function factLine(label: string, confirmed: boolean) {
  return (
    <li>
      {label}: {confirmed ? "confirmed by you." : "not yet confirmed."}
    </li>
  );
}

export default function SecureSetup({
  environments = [],
  environmentConfirmations = [],
}: {
  environments?: Environment[];
  environmentConfirmations?: EnvironmentConfirmation[];
}) {
  const [connection, setConnection] = useState<{ status: string; message: string } | null>(null);
  const [status, setStatus] = useState<Setup | null>(null);
  const [busy, setBusy] = useState("");
  const [aiProvider, setAiProvider] = useState("openai");
  const [aiModel, setAiModel] = useState("gpt-4.1-mini");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await call("/setup/status"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup is unavailable.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([call("/setup/status"), call("/setup/browser-login")])
      .then(([setup, current]) => {
        if (!active) return;
        setStatus(setup);
        setConnection({ status: current.status || "idle", message: current.message || "" });
        if (["starting", "waiting"].includes(current.status || "")) setBusy("visible");
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Setup is unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!connection || !["starting", "waiting"].includes(connection.status)) return;
    const timer = setInterval(() => {
      call("/setup/browser-login")
        .then((value) => {
          setConnection({ status: value.status || "failed", message: value.message || "" });
          if (!["starting", "waiting"].includes(value.status || "")) {
            setBusy("");
            if (value.status === "passed") {
              setMessage(value.message || "Account verified.");
              void refresh();
            } else setError(value.message || "Sign-in could not be verified.");
          }
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : "Connection check failed.");
          setBusy("");
          setConnection(null);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [connection, refresh]);

  async function connectVisible() {
    setBusy("visible");
    setError("");
    setMessage("");
    try {
      const value = await call("/setup/browser-login", {});
      setConnection({ status: value.status || "failed", message: value.message || "" });
    } catch (e) {
      setBusy("");
      setError(e instanceof Error ? e.message : "Could not open sign-in.");
    }
  }

  async function saveLogin(event: React.FormEvent<HTMLFormElement>, environmentId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(environmentId);
    setError("");
    setMessage("");
    try {
      const result = await call("/setup/credentials", {
        kind: "lawcus",
        environmentId,
        username: data.get("username"),
        password: data.get("password"),
      });
      form.reset();
      setMessage(result.message || "Saved.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save credentials.");
    } finally {
      setBusy("");
    }
  }

  async function saveAi(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy("ai");
    setError("");
    setMessage("");
    try {
      const result = await call("/setup/credentials", {
        kind: "ai",
        provider: aiProvider,
        model: aiModel.trim(),
        apiKey: data.get("apiKey"),
      });
      form.reset();
      setMessage(result.message || "Saved.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save credentials.");
    } finally {
      setBusy("");
    }
  }

  const stagingEnvironments = environments.filter((e) => e.kind !== "fixture");

  return (
    <section className="panel" style={{ marginBottom: 24 }}>
      <div className="panel-heading">
        <div>
          <span className="section-label">SECURE CONNECTIONS</span>
          <h2>Connect each Lawcus environment</h2>
        </div>
        <ShieldCheck size={24} />
      </div>
      <p className="subtle">
        Credentials go to macOS Keychain on this Mac — one saved account per environment. Each
        password is used only to sign in to that environment. Neither the password nor the API key
        is ever included in test instructions or reports.
      </p>
      {error && (
        <p className="notice error" role="alert" style={{ marginTop: 16 }}>
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status" style={{ marginTop: 16 }}>
          {message}
        </p>
      )}

      <div className="environment-grid" style={{ marginTop: 24 }}>
        {stagingEnvironments.map((env) => {
          const facts = environmentConfirmations.find((c) => c.environmentId === env.id)?.facts;
          const saved = !!status?.loginConfiguredByEnvironment?.[env.id];
          return (
            <div key={env.id} className="panel" style={{ padding: 22 }}>
              <div className="panel-heading">
                <div>
                  <span className="section-label">ENVIRONMENT</span>
                  <h2>{env.name}</h2>
                </div>
                {facts?.staging && <Badge variant="outline">Staging confirmed</Badge>}
              </div>
              <div className="url-field">
                <Globe size={16} />
                {env.url}
              </div>
              {facts && (
                <ol className="next-steps">
                  {factLine("Staging environment", facts.staging)}
                  {factLine("Dedicated QA account", facts.dedicatedAccountAvailable)}
                  {factLine("No MFA, SSO or CAPTCHA", !facts.mfa && !facts.sso && !facts.captcha)}
                </ol>
              )}
              <form onSubmit={(e) => saveLogin(e, env.id)} autoComplete="off" style={{ marginTop: 18 }}>
                <h3 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {saved ? <CheckCircle2 size={16} /> : <KeyRound size={16} />} Account{saved ? " saved" : ""}
                </h3>
                <label htmlFor={`qa-user-${env.id}`}>Dedicated QA email</label>
                <Input id={`qa-user-${env.id}`} name="username" type="email" required autoComplete="off" style={{ margin: "7px 0 14px" }} />
                <label htmlFor={`qa-password-${env.id}`}>Password</label>
                <Input id={`qa-password-${env.id}`} name="password" type="password" required autoComplete="new-password" style={{ margin: "7px 0 14px" }} />
                <Button type="submit" disabled={!!busy}>
                  {busy === env.id ? <LoaderCircle className="spin" /> : <ShieldCheck />}
                  Save account securely
                </Button>
              </form>
              {env.id === INTERACTIVE_SIGNIN_ENVIRONMENT_ID && (
                <div style={{ marginTop: 18, padding: 14, border: "1px solid #dce4ec", borderRadius: 10 }}>
                  <h3>Or verify by signing in yourself</h3>
                  <p className="subtle">
                    Open a separate Chromium window and sign in. After identity is verified, this app
                    saves the working email and password here — no password shown in reports.
                  </p>
                  <Button style={{ marginTop: 10 }} disabled={!!busy} onClick={connectVisible}>
                    {busy === "visible" ? <LoaderCircle className="spin" /> : <ShieldCheck />}
                    Sign in and save verified account
                  </Button>
                  {connection && ["starting", "waiting"].includes(connection.status) && (
                    <>
                      <p role="status" className="small-note">
                        {connection.message}
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => {
                          void call("/setup/browser-login/cancel", {});
                        }}
                      >
                        Cancel sign-in
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div className="panel" style={{ padding: 22 }}>
          {(() => {
            const providers = AI_PROVIDER_OPTIONS.map((option) => ({
              ...option,
              configured: Boolean(status?.aiProviders?.find((p) => p.id === option.id)?.configured),
            }));
            const chosen = providers.find((p) => p.id === aiProvider);
            const active = status?.aiChoice;
            const activeLabel = providers.find((p) => p.id === active?.provider)?.label;
            return (
              <>
                <div className="panel-heading">
                  <div>
                    <span className="section-label">AI PLANNER</span>
                    <h2>{activeLabel ? `Planning with ${activeLabel}` : "Connect an AI provider"}</h2>
                  </div>
                  {status?.aiConfigured && <Badge variant="outline">Configured</Badge>}
                </div>
                {active && (
                  <p className="subtle">
                    Current model: <code>{active.model}</code>. Keys for other providers stay saved; choose one below to switch.
                  </p>
                )}
                <p className="subtle">
                  {chosen && (
                    <>
                      Get a key from{" "}
                      <a href={chosen.keyPage} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                        {chosen.label}&rsquo;s API keys page
                      </a>
                      .{" "}
                    </>
                  )}
                  Your key is sent only to that provider&rsquo;s own address. Only your test intent and a bounded login-testing contract
                  are sent for planning; no page contents or staging credentials are sent.
                </p>
                <form onSubmit={saveAi} autoComplete="off" style={{ marginTop: 18 }}>
                  <label htmlFor="ai-provider">Provider</label>
                  <select
                    id="ai-provider"
                    value={aiProvider}
                    onChange={(e) => {
                      const next = providers.find((p) => p.id === e.target.value);
                      setAiProvider(e.target.value);
                      if (next) setAiModel(next.defaultModel);
                    }}
                    style={{ display: "block", width: "100%", margin: "7px 0 14px", padding: "8px 10px", borderRadius: 8 }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {p.configured ? " (key saved)" : ""}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="ai-model">Model name</label>
                  <Input id="ai-model" name="model" value={aiModel} onChange={(e) => setAiModel(e.target.value)} required style={{ margin: "7px 0 14px" }} />
                  <label htmlFor="ai-key">{chosen ? `${chosen.label} API key` : "API key"}</label>
                  <Input id="ai-key" name="apiKey" type="password" required autoComplete="new-password" placeholder="Paste your key" style={{ margin: "7px 0 14px" }} />
                  <Button type="submit" disabled={!!busy || !aiModel.trim()}>
                    {busy === "ai" ? <LoaderCircle className="spin" /> : <ShieldCheck />}
                    Save key and use this provider
                  </Button>
                </form>
              </>
            );
          })()}
        </div>
      </div>

      <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid #dce4ec" }}>
        <Button
          disabled={!!busy}
          onClick={async () => {
            setBusy("browser");
            setError("");
            try {
              const result = await call("/runner/check", {});
              if (result.ready) setMessage(result.message || "Browser ready.");
              else setError(result.message || "Browser unavailable.");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Browser check failed.");
            } finally {
              setBusy("");
            }
          }}
        >
          {busy === "browser" ? <LoaderCircle className="spin" /> : <CheckCircle2 />}
          Check browser connection
        </Button>
        <p className="small-note">
          <LockKeyhole size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          Staging evidence is encrypted on this Mac and includes screenshots plus a redacted execution
          trace. Raw browser traces are disabled.
        </p>
      </div>
      <p className="small-note">
        macOS may ask you to allow the app&rsquo;s Keychain access. Enter secrets only in these fields.
        Leave every account blank if you only want to use the local test application.
      </p>
    </section>
  );
}
