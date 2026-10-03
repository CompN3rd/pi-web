import type { PiWebServerPlugin, ServerPluginActivationContext, ServerPluginPeerRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import { isGitSource, isWorkspacePath, MAX_FILES, MAX_TEXT_LENGTH, record } from "./protocol.js";

// Do not inherit the repository/index of the process hosting the daemon.
const gitEnvironment = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_QUARANTINE_PATH", "GIT_WORK_TREE",
];

export async function requestGit(execFile: ServerPluginActivationContext["execFile"], request: ServerPluginPeerRequestContext) {
  const { input, operation, workspace, signal } = request;
  if (!record(input) || !isGitSource(input["source"])) throw new Error("Invalid Git review source");
  if (operation !== "changes" && operation !== "diff") throw new Error("Unknown review operation");
  const path = input["path"];
  if (operation === "diff" && !isWorkspacePath(path)) throw new Error("Invalid workspace-relative review path");
  const args = ["--literal-pathspecs", "-C", workspace.path, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--relative"];
  if (input["source"] === "git-staged") args.push("--cached");
  if (operation === "changes") args.push("--name-only", "-z");
  else args.push("--unified=3");
  args.push("--");
  if (operation === "diff" && typeof path === "string") args.push(path);
  const result = await execFile({ file: "git", args, cwd: workspace.path, env: { GIT_OPTIONAL_LOCKS: "0" }, unsetEnv: gitEnvironment, signal, timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.signal !== null) throw new Error(`Git review failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`);
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error("Git output exceeds the host limit; narrow the review");
  if (operation === "changes") {
    const paths = result.stdout.split("\0").filter((entry) => entry !== "");
    if (paths.length > MAX_FILES) throw new Error("Too many changed files; narrow the review");
    if (!paths.every(isWorkspacePath)) throw new Error("Git returned a filename this review plugin cannot safely address");
    return paths;
  }
  if (result.stdout.length > MAX_TEXT_LENGTH) throw new Error("Diff is too large to review inline");
  return result.stdout;
}

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "Code Review",
  activate: ({ execFile }) => ({ peer: { request: (request) => requestGit(execFile, request) } }),
};
export default plugin;
