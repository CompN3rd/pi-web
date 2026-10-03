import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";

// Consume existing artifacts, optionally from an extracted tarball. Never rebuild here.
const root = resolve(process.argv[2] ?? ".");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const entry = manifest.piWeb.plugins[0];
assert.equal(entry.id, "code-review");
assert.equal(entry.machineSpecific, true);
assert(!relative(resolve(root, entry.browserRoot), resolve(root, entry.module)).startsWith(".."));
assert(relative(resolve(root, entry.browserRoot), resolve(root, entry.serverModule)).startsWith(".."));
const server = (await import(pathToFileURL(resolve(root, entry.serverModule)).href)).default;
assert.equal(server.apiVersion, 3);
let command;
const serverActivation = await server.activate({ execFile: async (input) => {
  command = input;
  return { exitCode: 0, signal: null, stdout: "a.ts\0", stderr: "", stdoutTruncated: false, stderrTruncated: false };
} });
const workspace = { id: "w", projectId: "p", path: "/workspace", label: "main", isMain: true };
const lifetime = new AbortController();
assert.deepEqual(await serverActivation.peer.request({ workspace, operation: "changes", input: { source: "git-staged" }, signal: lifetime.signal }), ["a.ts"]);
assert.equal(command.cwd, workspace.path);
assert(command.args.includes("--cached"));

const window = new Window();
for (const key of ["window", "document", "customElements", "HTMLElement", "Document", "ShadowRoot", "CSSStyleSheet", "localStorage"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] });
}
try {
  const { html, svg, render } = await import("lit");
  const browser = (await import(pathToFileURL(resolve(root, entry.module)).href)).default;
  assert.equal(browser.apiVersion, 4);
  const activation = await browser.activate({ html, svg, runtimePluginId: "smoke", pluginId: "smoke", signal: new AbortController().signal, lifetimeSignal: lifetime.signal });
  const contribution = activation.contributions.workspacePanels[0];
  const context = {
    machine: { id: "local", name: "Local", kind: "local" }, workspace,
    files: { listFiles: async () => ({ entries: [], truncated: false }) },
    host: { requestRender() {} },
  };
  const host = window.document.createElement("div"); window.document.body.append(host);
  render(contribution.render(context), host);
  await host.firstElementChild.updateComplete;
  await window.happyDOM.waitUntilComplete();
  assert(host.firstElementChild.shadowRoot.textContent.includes("Saved comments (0)"));
  lifetime.abort();
  activation.dispose(new AbortController().signal);
  assert.equal(host.firstElementChild, null);
  console.log("Standalone browser/server artifact smoke passed.");
} finally {
  lifetime.abort();
  await window.happyDOM.close();
}
