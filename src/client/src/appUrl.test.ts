import { describe, expect, it } from "vitest";
import { workspaceFilePreviewUrl } from "./api/urls";
import { resolveAppUrl, resolveAppWebSocketUrl, type AppUrlContext } from "./appUrl";

const rootHttpContext: AppUrlContext = {
  viteBaseUrl: "/",
  documentBaseUrl: "http://pi.example.test/",
};

const nestedHttpsContext: AppUrlContext = {
  viteBaseUrl: "./",
  documentBaseUrl: "https://pi.example.test/test/ai/",
};

describe("application URLs", () => {
  it("resolves app-owned paths at an HTTP root deployment", () => {
    expect(resolveAppUrl("api/pi-web/status", rootHttpContext)).toBe("http://pi.example.test/api/pi-web/status");
    expect(resolveAppUrl("/pi-web-plugins/manifest.json", rootHttpContext)).toBe("http://pi.example.test/pi-web-plugins/manifest.json");
  });

  it("resolves paths within a canonical nested HTTPS deployment", () => {
    expect(resolveAppUrl("api/pi-web/status", nestedHttpsContext)).toBe("https://pi.example.test/test/ai/api/pi-web/status");
    expect(resolveAppUrl("/pi-web-plugins/manifest.json", nestedHttpsContext)).toBe("https://pi.example.test/test/ai/pi-web-plugins/manifest.json");
  });

  it("builds nested, machine-bound PDF preview URLs with encoded identifiers and paths", () => {
    expect(workspaceFilePreviewUrl("project / one", "work space", "raw/paper #1.pdf", {
      machineId: "remote / a",
      modifiedAt: "2026-08-08T10:00:00.000Z",
      context: nestedHttpsContext,
    })).toBe("https://pi.example.test/test/ai/api/machines/remote%20%2F%20a/projects/project%20%2F%20one/workspaces/work%20space/file/preview?path=raw%2Fpaper+%231.pdf&v=2026-08-08T10%3A00%3A00.000Z");
  });

  it("preserves encoded path segments and query parameters", () => {
    expect(resolveAppUrl("api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one&before=10", nestedHttpsContext))
      .toBe("https://pi.example.test/test/ai/api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one&before=10");
  });
});

describe("application WebSocket URLs", () => {
  it("maps root HTTP URLs to absolute ws URLs", () => {
    expect(resolveAppWebSocketUrl("api/machines/local/events", rootHttpContext)).toBe("ws://pi.example.test/api/machines/local/events");
  });

  it("maps nested HTTPS URLs to absolute wss URLs without losing path or query data", () => {
    expect(resolveAppWebSocketUrl("api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one", nestedHttpsContext))
      .toBe("wss://pi.example.test/test/ai/api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one");
  });
});
