import { describe, expect, it, vi } from "vitest";
import { resolveUpstreamRelease } from "./upstream-image-release.mjs";

function release(version) {
  return { name: "@jmfederico/pi-web", version, dist: { integrity: "sha512-test" } };
}
function registry(...releases) {
  const fetchMetadata = vi.fn();
  for (const value of releases) fetchMetadata.mockResolvedValueOnce({ ok: true, json: async () => value });
  return fetchMetadata;
}

describe("upstream npm image selection", () => {
  it("selects upstream latest independently of this checkout's package version", async () => {
    const fetchMetadata = registry(release("1.202610.99"));
    await expect(resolveUpstreamRelease("latest", fetchMetadata)).resolves.toEqual({ version: "1.202610.99", isLatest: true });
    expect(fetchMetadata).toHaveBeenCalledExactlyOnceWith("https://registry.npmjs.org/@jmfederico%2fpi-web/latest");
  });

  it("does not move latest when manually selecting an older published version", async () => {
    const fetchMetadata = registry(release("1.202610.99"), release("1.202610.6"));
    await expect(resolveUpstreamRelease("1.202610.6", fetchMetadata)).resolves.toEqual({ version: "1.202610.6", isLatest: false });
  });

  it("updates latest when the explicitly selected version is upstream latest", async () => {
    const fetchMetadata = registry(release("1.202610.99"), release("1.202610.99"));
    await expect(resolveUpstreamRelease("1.202610.99", fetchMetadata)).resolves.toMatchObject({ isLatest: true });
  });

  it.each(["^1.0.0", "main", "next", "1.2.3\ninjected=value"])("rejects non-exact selectors: %s", async (requested) => {
    const fetchMetadata = vi.fn();
    await expect(resolveUpstreamRelease(requested, fetchMetadata)).rejects.toThrow("exact upstream npm version");
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  it("fails visibly on registry errors", async () => {
    const fetchMetadata = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(resolveUpstreamRelease("latest", fetchMetadata)).rejects.toThrow("HTTP 503");
  });

  it.each([
    { name: "wrong-package", version: "1.2.3", dist: { integrity: "sha512-test" } },
    { name: "@jmfederico/pi-web", version: "not-a-version" },
    { name: "@jmfederico/pi-web", version: "1.2.3" },
  ])("rejects invalid release metadata", async (metadata) => {
    await expect(resolveUpstreamRelease("latest", registry(metadata))).rejects.toThrow("Invalid upstream");
  });

  it("rejects mismatched exact-version responses", async () => {
    await expect(resolveUpstreamRelease("1.2.3", registry(release("1.2.4"), release("1.2.5")))).rejects.toThrow("does not match");
  });
});
