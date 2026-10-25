import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const packageName = "@jmfederico/pi-web";
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export async function resolveUpstreamRelease(requested = "latest", fetchMetadata = fetch) {
  if (requested !== "latest" && !exactVersion.test(requested)) {
    throw new Error("Use latest or an exact upstream npm version, not a range or Git ref");
  }
  async function metadata(selector) {
    const response = await fetchMetadata(`https://registry.npmjs.org/@jmfederico%2fpi-web/${encodeURIComponent(selector)}`);
    if (!response.ok) throw new Error(`Upstream npm lookup failed: HTTP ${response.status}`);
    const value = await response.json();
    if (value.name !== packageName || !exactVersion.test(value.version ?? "") || !value.dist?.integrity) {
      throw new Error("Invalid upstream npm release metadata");
    }
    return value;
  }
  const latest = await metadata("latest");
  const selected = requested === "latest" ? latest : await metadata(requested);
  if (requested !== "latest" && selected.version !== requested) throw new Error("Upstream version does not match request");
  // OCI tags cannot contain SemVer build metadata.
  if (selected.version.includes("+")) throw new Error("npm versions with build metadata cannot be used as image tags");
  return { version: selected.version, isLatest: selected.version === latest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = await resolveUpstreamRelease(process.env["UPSTREAM_VERSION"] || "latest");
  const repository = process.env["GITHUB_REPOSITORY"]?.toLowerCase();
  if (!repository || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY");
  await appendFile(process.env["GITHUB_OUTPUT"], `version=${release.version}\nis-latest=${release.isLatest}\nimage=ghcr.io/${repository}\n`);
}
