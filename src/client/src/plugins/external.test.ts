import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalPluginLoader } from "./external";
import { PluginRegistry } from "./registry";
import type { PiWebPlugin } from "./types";

function fixture() {
  const registry = new PluginRegistry();
  const dispose = vi.fn();
  const plugin: PiWebPlugin = { apiVersion: 1, name: "Example", activate: () => ({ contributions: {}, dispose }) };
  const dependencies = {
    fetchManifest: vi.fn<() => Promise<{ plugins: { id: string; module: string }[] } | undefined>>()
      .mockResolvedValue({ plugins: [{ id: "example", module: "./example.js?existing=yes" }] }),
    importModule: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({ default: plugin }),
    baseUrl: () => "https://example.com/chat",
    revision: vi.fn<() => string>().mockReturnValueOnce("first").mockReturnValue("second"),
    warn: vi.fn(),
  };
  return { registry, dispose, plugin, dependencies, loader: new ExternalPluginLoader(registry, dependencies) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("external plugin reload", () => {
  it("supports the default loader dependencies without secure-context crypto APIs", async () => {
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ plugins: [] }) }));
    const loader = new ExternalPluginLoader(new PluginRegistry());
    await expect(loader.reload()).resolves.toBeUndefined();
    await expect(loader.reload()).resolves.toBeUndefined();
  });

  it("retains active plugins when the manifest is unavailable, but removes them for an explicit empty manifest", async () => {
    const { loader, dependencies, dispose } = fixture();
    await loader.reload();
    dependencies.fetchManifest.mockResolvedValueOnce(undefined);
    await loader.reload();
    expect(dispose).not.toHaveBeenCalled();
    expect(dependencies.importModule).toHaveBeenCalledTimes(1);
    dependencies.fetchManifest.mockResolvedValueOnce({ plugins: [] });
    await loader.reload();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("treats an HTTP 404 from the default manifest fetcher as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));
    await expect(new ExternalPluginLoader(new PluginRegistry()).reload()).resolves.toBeUndefined();
  });

  it("rediscovers plugins and replaces them with freshly imported entrypoints", async () => {
    const { loader, dependencies, dispose } = fixture();
    await loader.reload();
    expect(dispose).not.toHaveBeenCalled();
    await loader.reload();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchManifest).toHaveBeenCalledTimes(2);
    expect(dependencies.importModule.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/pi-web-plugins/example.js?existing=yes&pi-web-reload=first",
      "https://example.com/pi-web-plugins/example.js?existing=yes&pi-web-reload=second",
    ]);
  });

  it("retains old activations on import or activation failures, then retries", async () => {
    const { loader, dependencies, dispose } = fixture();
    await loader.reload();
    dependencies.importModule.mockRejectedValueOnce(new Error("broken bundle"));
    await loader.reload();
    dependencies.importModule.mockResolvedValueOnce({ default: { apiVersion: 1, name: "Broken", activate: () => { throw new Error("broken activation"); } } });
    await loader.reload();
    expect(dispose).not.toHaveBeenCalled();
    expect(dependencies.warn).toHaveBeenCalledTimes(2);
    await loader.reload();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("unregisters removed external plugins without removing built-ins", async () => {
    const { loader, registry, plugin, dependencies, dispose } = fixture();
    const coreDispose = vi.fn();
    registry.register({ id: "core", plugin: { ...plugin, activate: () => ({ contributions: {}, dispose: coreDispose }) } });
    await loader.reload();
    dependencies.fetchManifest.mockResolvedValue({ plugins: [] });
    await loader.reload();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(coreDispose).not.toHaveBeenCalled();
  });

  it("does not overwrite a built-in plugin with a colliding manifest id", async () => {
    const { loader, registry, plugin, dependencies, dispose } = fixture();
    registry.register({ id: "example", plugin });
    await loader.reload();
    await loader.reload();
    expect(dispose).not.toHaveBeenCalled();
    expect(dependencies.warn).toHaveBeenCalledTimes(2);
  });

  it("keeps all current activations when discovery fails or duplicates ids", async () => {
    const { loader, dependencies, dispose } = fixture();
    await loader.reload();
    dependencies.fetchManifest.mockRejectedValueOnce(new Error("offline"));
    await expect(loader.reload()).rejects.toThrow("offline");
    dependencies.fetchManifest.mockResolvedValue({ plugins: [{ id: "example", module: "a.js" }, { id: "example", module: "b.js" }] });
    await expect(loader.reload()).rejects.toThrow("Duplicate");
    expect(dispose).not.toHaveBeenCalled();
    expect(dependencies.importModule).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping reloads and permits subsequent reloads", async () => {
    const { loader, dependencies } = fixture();
    const first = loader.reload();
    expect(loader.reload()).toBe(first);
    await first;
    await loader.reload();
    expect(dependencies.fetchManifest).toHaveBeenCalledTimes(2);
  });
});
