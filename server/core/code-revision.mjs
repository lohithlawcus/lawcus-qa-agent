import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Which code produced a result. Computed once at process start: a run
// records the revision the server was launched with, plus "+dirty" if any
// tracked file differed from that commit at that moment. Falls back to
// "unknown" (never throws) when git isn't available.
let cached;
export function currentCodeRevision() {
  if (cached) return cached;
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    cached = dirty ? `${sha}+dirty` : sha;
  } catch {
    cached = "unknown";
  }
  return cached;
}
