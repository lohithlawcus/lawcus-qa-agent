// Private channel for carrying evidence (a screenshot Buffer) from a
// browser primitive to whoever handles its failure. Deliberately NOT a
// property on the Error: an own property would be visible to
// JSON.stringify, util.inspect, console.log(error) and any error
// serializer, which is how raw evidence could leak into logs or an HTTP
// response. A WeakMap keyed by the Error object is invisible to all of
// those and is garbage-collected with the error.
const evidenceByError = new WeakMap();

export function attachEvidence(error, evidence) {
  if (error && typeof error === "object") evidenceByError.set(error, evidence);
  return error;
}

export function takeEvidence(error) {
  if (!error || typeof error !== "object") return null;
  const evidence = evidenceByError.get(error) ?? null;
  evidenceByError.delete(error);
  return evidence;
}

/** A failure/diagnostic screenshot with every password input masked, so a
 * page that happens to show a typed password can never put it in evidence.
 * Deliberately narrower than the login suite's screenshots (which mask all
 * inputs): native checks photograph a QA-owned fixture record and the point
 * is to make its field values visible. Returns null if it cannot capture. */
export async function captureScreenshot(page) {
  try {
    return await page.screenshot({ fullPage: false, mask: [page.locator('input[type="password"]')] });
  } catch {
    return null;
  }
}

// Browser contexts that are open right now. A login-backed check registers its
// context while it runs, so a check that stops responding can still be photographed.
const liveContexts = new Set();
export function registerLiveContext(context) {
  liveContexts.add(context);
}
export function unregisterLiveContext(context) {
  liveContexts.delete(context);
}

/** Closes every open login-backed context, which ends the browser step that is running in it. */
export async function closeLiveContexts() {
  const open = [...liveContexts];
  await Promise.all(open.map((context) => Promise.resolve().then(() => context.close()).catch(() => {})));
  return open.length;
}

/** A screenshot of the most recently used open page, with that page's path
 * (never its query string) so a stalled step can be placed. Null when no
 * context is open or the capture fails. */
export async function captureStalledPage() {
  try {
    const pages = [...liveContexts].flatMap((context) => {
      try {
        return context.pages();
      } catch {
        return [];
      }
    });
    const page = pages.at(-1);
    if (!page) return null;
    const screenshot = await captureScreenshot(page);
    if (!screenshot) return null;
    let where = "unknown page";
    try {
      where = new URL(page.url()).pathname;
    } catch {
      // keep the placeholder
    }
    return { screenshot, where };
  } catch {
    return null;
  }
}
