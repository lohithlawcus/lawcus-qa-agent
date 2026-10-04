// V5 Step 14 / section 29 — Recorder / Teaching Mode Foundation.
//
// This file is split the same way network-observer.mjs was in Step 11:
// pure, DB-free, browser-free logic (normalize/classify/match/propose —
// fully unit-tested) versus attachRecorder(), the one function that
// actually touches a live Playwright BrowserContext (proven by live
// verification, same as attachNetworkObserver()).
//
// Section 29.1: "Do not depend on private Playwright Inspector APIs or
// undocumented recorder internals." This deliberately does NOT shell out
// to the separate `playwright codegen` CLI (whose recorded output is only
// ever written to the Inspector's own window/file, with no public Node
// API to read it back into this process). Instead it builds recording on
// top of two ordinary, fully public, documented Playwright APIs —
// context.exposeBinding() and context.addInitScript() — the same
// technique any custom Playwright-based recorder uses. Nothing here reads
// from or writes to Playwright's actual Inspector/codegen internals.

const SECRET_FIELD_PATTERN = /password|passwd|token|secret|api[-_]?key|ssn|ccnum|cvv|credit[-_]?card/i;
const STABLE_STRATEGIES = new Set(["testid", "aria-label", "label", "placeholder", "id", "text"]);

/** Decides, from field identity alone (never the value's own content —
 * this runs server-side on data the browser-side script already decided
 * not to transmit for secrets, but stays defense-in-depth), whether a
 * captured value must be redacted. Section 29.3's literal example is
 * "${persona.credentials.password}" — reproduced here whenever the field
 * looks like the the current persona's password specifically. */
export function classifyValue({ fieldType, fieldName, fieldLabel, personaLabel = null }) {
  const identity = [fieldType, fieldName, fieldLabel].filter(Boolean).join(" ");
  const looksSecret = fieldType === "password" || SECRET_FIELD_PATTERN.test(identity);
  if (!looksSecret) return { redacted: false };
  const looksLikePassword = fieldType === "password" || /password|passwd/i.test(identity);
  return {
    redacted: true,
    reference: looksLikePassword && personaLabel ? `\${${personaLabel}.credentials.password}` : "${redacted}",
  };
}

/** Section 29.5: a locator with no semantic hook — only a positional CSS
 * fallback — is never "good"; it can only ever produce a
 * TESTABILITY_HOOK_REQUEST, never a NEW_TEST/NEW_PRIMITIVE candidate on
 * its own. */
export function locatorQuality(strategy) {
  return STABLE_STRATEGIES.has(strategy) ? "stable" : "unstable";
}

/** Collapses a flood of raw 'input' events on the same field down to one
 * candidate action carrying the field's final committed value — a real
 * recording normalization step (section 29's "Normalize recording"), not
 * a no-op passthrough. Click/submit/navigate events are never collapsed. */
export function normalizeCandidateActions(rawActions) {
  const normalized = [];
  for (const action of rawActions) {
    const prior = normalized[normalized.length - 1];
    const sameField =
      prior &&
      (action.actionType === "input" || action.actionType === "change") &&
      prior.actionType === action.actionType &&
      JSON.stringify(prior.locatorCandidate) === JSON.stringify(action.locatorCandidate);
    if (sameField) {
      normalized[normalized.length - 1] = { ...action, sequence: prior.sequence };
    } else {
      normalized.push({ ...action, sequence: normalized.length });
    }
  }
  return normalized;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Matches each candidate action against the approved primitive registry.
 * `knownMatchers` is an optional caller-supplied map from a normalized
 * semantic label to a primitive id — the extension point a primitive can
 * eventually declare ("this primitive is what a recorded click on the
 * login submit control matches"), which the current primitive registry
 * schema doesn't carry yet. Without one, matching is real but honestly
 * limited: an action matches only when its own description, normalized,
 * exactly equals an approved primitive's own action text, normalized —
 * never a fuzzy/invented correspondence. For a genuinely new workflow
 * (section 29's own example: "click Contact Custom Fields / open field /
 * change name / save") this will correctly find nothing, which is the
 * expected, honest outcome, not a bug.
 */
export function matchActionsToPrimitives(actions, approvedPrimitives, { knownMatchers = {} } = {}) {
  const byNormalizedAction = new Map(approvedPrimitives.map((p) => [normalizeText(p.action), p.id]));
  return actions.map((action) => {
    const key = normalizeText(action.description);
    const matched = knownMatchers[key] ?? byNormalizedAction.get(key) ?? null;
    return { ...action, matchedPrimitiveId: matched };
  });
}

/**
 * Turns matched/unmatched candidate actions into proposal specs — plain
 * objects ready for proposals.create({...spec, generatedBy: "recorder"}),
 * never created here directly (this stays pure and DB-free so it's fully
 * unit-testable). Section 29.4: everything matched -> one NEW_TEST
 * proposal; anything missing -> one NEW_PRIMITIVE proposal per missing
 * capability, and no NEW_TEST proposal at all yet (engineering has to
 * build the primitive first). Section 29.5: an action with no stable
 * locator gets a TESTABILITY_HOOK_REQUEST instead of/alongside its
 * NEW_PRIMITIVE proposal.
 */
export function buildProposalSpecs({ session, actions, testCaseSubjectId }) {
  const specs = [];
  const unstable = actions.filter((a) => locatorQuality(a.locatorCandidate.strategy) === "unstable");
  for (const action of unstable) {
    specs.push({
      type: "TESTABILITY_HOOK_REQUEST",
      summary: `No stable locator was found for "${action.description}" in ${session.feature_name}. A data-testid or aria-label is needed.`,
      trigger: `authoring_session ${session.id}, action #${action.sequence}`,
      subjectKind: "testability_hook",
      subjectId: `${session.feature_name}.${action.sequence}`,
      proposedValue: JSON.stringify({ description: action.description, observedLocator: action.locatorCandidate }),
      risk: "low",
      requiredApproverRole: "engineering",
    });
  }
  const missing = actions.filter((a) => !a.matchedPrimitiveId);
  if (missing.length) {
    for (const action of missing) {
      specs.push({
        type: "NEW_PRIMITIVE",
        summary: `No approved primitive performs "${action.description}" (${session.feature_name}).`,
        trigger: `authoring_session ${session.id}, action #${action.sequence}`,
        subjectKind: "primitive",
        subjectId: `${session.feature_name}.${normalizeText(action.description).replaceAll(" ", "_")}`,
        proposedValue: JSON.stringify({
          description: action.description,
          actionType: action.actionType,
          locatorCandidate: action.locatorCandidate,
          redacted: action.redacted,
        }),
        risk: "medium",
        requiredApproverRole: "engineering",
      });
    }
    return specs;
  }
  specs.push({
    type: "NEW_TEST",
    summary: `Recorded workflow "${session.workflow_description}" (${session.feature_name}) — every action matched an approved primitive.`,
    trigger: `authoring_session ${session.id}`,
    subjectKind: "test_case",
    subjectId: testCaseSubjectId,
    proposedValue: JSON.stringify({
      feature: session.feature_name,
      name: session.workflow_description,
      steps: actions.map((a) => ({ primitive: a.matchedPrimitiveId, description: a.description })),
    }),
    risk: "medium",
    requiredApproverRole: "engineering",
  });
  return specs;
}

// --- Browser-facing capture (proven live, not by unit test) -----------

const IN_PAGE_RECORDER_SCRIPT = `(() => {
  if (window.__qaRecorderAttached) return;
  window.__qaRecorderAttached = true;
  const SECRET = /password|passwd|token|secret|api[-_]?key|ssn|ccnum|cvv|credit[-_]?card/i;
  function locatorFor(el) {
    const testid = el.closest('[data-testid]');
    if (testid) return { strategy: 'testid', value: testid.getAttribute('data-testid') };
    const ariaEl = el.closest('[aria-label]');
    if (ariaEl) return { strategy: 'aria-label', value: ariaEl.getAttribute('aria-label') };
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && label.textContent.trim()) return { strategy: 'label', value: label.textContent.trim().slice(0, 120) };
    }
    if (el.placeholder) return { strategy: 'placeholder', value: el.placeholder.slice(0, 120) };
    if (el.id) return { strategy: 'id', value: el.id };
    const text = (el.textContent || '').trim();
    if (text && text.length <= 80) return { strategy: 'text', value: text };
    const path = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      const parent = node.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
      path.unshift(node.tagName.toLowerCase() + ':nth-child(' + (index + 1) + ')');
      node = parent;
    }
    return { strategy: 'css-path', value: path.join(' > ') };
  }
  function fieldIdentity(el) {
    return [el.type, el.name, el.id, el.getAttribute('aria-label'), el.placeholder].filter(Boolean).join(' ');
  }
  function report(actionType, el, extra) {
    try {
      window.__qaRecordAction({
        actionType,
        locatorCandidate: locatorFor(el),
        tag: el.tagName ? el.tagName.toLowerCase() : null,
        ...extra,
      });
    } catch {}
  }
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('button,a,[role="button"],input[type="submit"],input[type="button"]') : null;
    if (el) report('click', el, {});
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !('value' in el)) return;
    const secret = SECRET.test(fieldIdentity(el)) || el.type === 'password';
    report('change', el, {
      fieldType: el.type || null,
      fieldName: el.name || null,
      fieldLabel: el.getAttribute('aria-label') || el.placeholder || null,
      redacted: secret,
      value: secret ? null : String(el.value).slice(0, 200),
    });
  }, true);
  document.addEventListener('submit', (e) => {
    const el = e.target;
    if (el) report('submit', el, {});
  }, true);

  // 2026-10-05: "Teaching" marker, by the operator's explicit decision —
  // navigating/exploring to find the right screen should not itself become
  // a proposal, only the steps the operator deliberately brackets. The
  // actual filtering happens server-side (attachRecorder below checks this
  // before ever pushing an action), so a navigation that re-runs this whole
  // script can't silently lose or duplicate anything; this button only
  // toggles that server-side flag and reflects its current value, read back
  // from it on every fresh page. Rendered in a closed shadow root — on a
  // real Lawcus page, not a sandbox — so its own click is never itself
  // mistaken for a recorded action (closest() can't reach into a closed
  // shadow root from the document listener above) and its styling can
  // never collide with the host page's.
  //
  // Draggable (the operator asked: it was sitting on top of real page
  // buttons), with its position remembered across navigations the same way
  // the teaching flag itself is — via __qaGet/SetMarkerPosition, Node-side
  // state, not anything stored in this page. While teaching is ON it
  // collapses to a small dot (it's no longer something to act on moment to
  // moment, just a reminder it's running) and expands back to the full
  // "stop" button on hover, so stopping stays one obvious click away.
  (function renderTeachingMarker() {
    function mount() {
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = [
        '.marker{all:initial;position:relative;display:flex;align-items:center;cursor:grab;',
        '  box-shadow:0 2px 10px rgba(0,0,0,.3);transition:width .15s ease,height .15s ease,padding .15s ease;',
        '  font:600 13px system-ui,sans-serif;user-select:none;touch-action:none;border-radius:999px;box-sizing:border-box;}',
        '.marker:active{cursor:grabbing}',
        '.marker.off{padding:8px 14px;border:2px solid #0f7d3f;background:#ffffff;color:#0f7d3f;white-space:nowrap;}',
        '.marker.on{width:16px;height:16px;padding:0;border:2px solid #b3261e;background:#e5483f;overflow:hidden;white-space:nowrap;}',
        '.marker.on:hover,.marker.on.dragging{width:auto;height:auto;padding:8px 14px;border:2px solid #b3261e;background:#e5483f;color:#ffffff;}',
        '.marker.on .label{display:none}',
        '.marker.on:hover .label,.marker.on.dragging .label{display:inline}',
      ].join('');
      shadow.appendChild(style);
      const btn = document.createElement('button');
      btn.className = 'marker off';
      const label = document.createElement('span');
      label.className = 'label';
      btn.appendChild(label);
      shadow.appendChild(btn);

      let teaching = false;
      function render() {
        btn.className = 'marker ' + (teaching ? 'on' : 'off');
        label.textContent = teaching ? '\\u25CF Teaching ON \\u2014 click to stop' : '\\u25CB Start teaching';
      }
      render();
      window.__qaGetTeaching().then((value) => { teaching = Boolean(value); render(); }).catch(() => {});

      // Positioning: top/right by default (matches the very first version);
      // switches to an explicit left/top pixel position, clamped to the
      // viewport, the first time it's dragged, and is restored from the
      // last known position on every later page in this session.
      function applyPosition(pos) {
        if (!pos) return;
        const w = host.getBoundingClientRect().width || 40, h = host.getBoundingClientRect().height || 32;
        const x = Math.max(4, Math.min(window.innerWidth - w - 4, pos.x));
        const y = Math.max(4, Math.min(window.innerHeight - h - 4, pos.y));
        host.style.left = x + 'px'; host.style.top = y + 'px'; host.style.right = 'auto';
      }
      window.__qaGetMarkerPosition().then(applyPosition).catch(() => {});

      let dragging = false, moved = false, startX = 0, startY = 0, originX = 0, originY = 0;
      btn.addEventListener('pointerdown', (e) => {
        dragging = true; moved = false;
        startX = e.clientX; startY = e.clientY;
        const rect = host.getBoundingClientRect();
        originX = rect.left; originY = rect.top;
        try { btn.setPointerCapture(e.pointerId); } catch {}
      });
      btn.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) { moved = true; btn.classList.add('dragging'); }
        if (moved) applyPosition({ x: originX + dx, y: originY + dy });
      });
      btn.addEventListener('pointerup', async (e) => {
        dragging = false;
        try { btn.releasePointerCapture(e.pointerId); } catch {}
        btn.classList.remove('dragging');
        if (moved) {
          const rect = host.getBoundingClientRect();
          window.__qaSetMarkerPosition(rect.left, rect.top).catch(() => {});
          return;
        }
        // Not a drag — a real click: toggle teaching.
        try { teaching = await window.__qaSetTeaching(!teaching); } catch { teaching = !teaching; }
        render();
      });

      document.documentElement.appendChild(host);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  })();
})();`;

/** Installs the in-page listeners above on every current/future page in
 * this context, and collects what they report. Only ever called against
 * a Lawcus-controlled context (see live-runner.mjs's
 * startAuthoringSession()) — never a generic/unrestricted browser
 * (section 29.1). */
export async function attachRecorder(context, { personaLabel = null } = {}) {
  const actions = [];
  let sequence = 0;
  // Off by default: exploring/navigating to find the right screen before
  // the operator marks "Start teaching" must never itself become a
  // proposal. This one flag is the actual filter — the in-page button
  // (IN_PAGE_RECORDER_SCRIPT) only ever calls __qaSetTeaching to change it
  // and __qaGetTeaching to reflect it; every action is still reported up
  // from the page regardless of this flag, and is only kept here while
  // teaching is on, so a slow page load can never drop a real action.
  let teaching = false;
  await context.exposeBinding("__qaRecordAction", (_source, payload) => {
    if (!teaching) return;
    const classification = payload.redacted
      ? classifyValue({ fieldType: payload.fieldType, fieldName: payload.fieldName, fieldLabel: payload.fieldLabel, personaLabel })
      : { redacted: false };
    actions.push({
      sequence: sequence++,
      actionType: payload.actionType,
      locatorCandidate: payload.locatorCandidate,
      description: describeAction(payload),
      redacted: classification.redacted,
      valueSummary: payload.redacted ? "redacted" : payload.value !== undefined ? `"${payload.value}"` : null,
      valueLiteral: payload.redacted ? null : (payload.value ?? null),
      valueReference: classification.reference ?? null,
    });
  });
  await context.exposeBinding("__qaSetTeaching", (_source, value) => {
    teaching = Boolean(value);
    return teaching;
  });
  await context.exposeBinding("__qaGetTeaching", () => teaching);
  // Remembers where the operator last dragged the marker to, so it doesn't
  // jump back on top of a button again after the next navigation. Node-side,
  // like `teaching` above — never stored in the page, so a fresh document's
  // copy of IN_PAGE_RECORDER_SCRIPT can read it straight back.
  let markerPosition = null;
  await context.exposeBinding("__qaSetMarkerPosition", (_source, x, y) => {
    markerPosition = { x, y };
  });
  await context.exposeBinding("__qaGetMarkerPosition", () => markerPosition);
  await context.addInitScript(IN_PAGE_RECORDER_SCRIPT);
  return {
    actions,
    isTeaching: () => teaching,
    dispose() {
      // exposeBinding cannot be removed once added; a disposed recorder
      // just stops being read by the caller. The context itself is always
      // closed right after (see live-runner.mjs), so nothing lingers.
    },
  };
}

function describeAction(payload) {
  const target = payload.locatorCandidate?.value || payload.tag || "element";
  if (payload.actionType === "click") return `click "${target}"`;
  if (payload.actionType === "submit") return `submit "${target}"`;
  if (payload.actionType === "change") return payload.redacted ? `set "${target}" (redacted)` : `set "${target}" to ${JSON.stringify(payload.value)}`;
  return `${payload.actionType} "${target}"`;
}
