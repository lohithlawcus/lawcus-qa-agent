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
