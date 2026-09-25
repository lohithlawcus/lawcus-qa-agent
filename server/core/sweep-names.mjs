// The names this tool gives the records it creates (see the native cases). A
// name is evidence that a record MAY be ours: it is never authority to touch
// it (resource-ownership.mjs says the same about deletion). Kept in its own
// file so the browser reader and the sweep logic can share it without
// importing each other.
const QA_NAME_PATTERNS = [/^QA Agent\b/i, /^QA Matter\b/i, /^QAFieldTest/i, /^QA Batch\b/i, /^QA impacted-test/i];

export const isQaNamed = (name) => typeof name === "string" && QA_NAME_PATTERNS.some((pattern) => pattern.test(name.trim()));
