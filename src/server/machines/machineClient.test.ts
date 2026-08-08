import { describe, expect, it, vi } from "vitest";
import { RemoteMachineClient } from "./machineClient.js";

describe("RemoteMachineClient", () => {
  it("forwards raw binary request bodies with the provided content type", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await client.request("PUT", "/api/projects/p1/workspaces/w1/file?path=image.png", payload, { contentType: "image/png" });

    const { input, init } = onlyFetchCall(fetchImpl);
    expect(fetchInputUrl(input)).toBe("https://remote.example.test/api/projects/p1/workspaces/w1/file?path=image.png");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("content-type")).toBe("image/png");
    if (!(init.body instanceof ArrayBuffer)) throw new Error("Expected binary request body");
    expect(Array.from(new Uint8Array(init.body))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serializes structured request bodies as JSON by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/base/", token: "secret" }, fetchImpl);

    await client.request("POST", "/api/sessions", { cwd: "/repo" });

    const { input, init } = onlyFetchCall(fetchImpl);
    expect(fetchInputUrl(input)).toBe("https://remote.example.test/base/api/sessions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ cwd: "/repo" }));
  });

  it("requests compression for the remote hop even when configured headers use different casing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({
      baseUrl: "https://remote.example.test/",
      headers: { "Accept-Encoding": "identity" },
    }, fetchImpl);

    await client.request("GET", "/api/projects");

    const { init } = onlyFetchCall(fetchImpl);
    expect(new Headers(init.headers).get("accept-encoding")).toBe("gzip, deflate");
  });

  it("forwards an explicit byte range with identity encoding without trusting configured range headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 206 })));
    const client = new RemoteMachineClient({
      baseUrl: "https://remote.example.test/",
      headers: { Range: "bytes=0-999", "If-Range": "stale", "Accept-Encoding": "gzip" },
    }, fetchImpl);

    await client.request("GET", "/api/file/preview", undefined, { range: "bytes=5-9", acceptEncoding: "identity" });

    const { init } = onlyFetchCall(fetchImpl);
    const headers = new Headers(init.headers);
    expect(headers.get("range")).toBe("bytes=5-9");
    expect(headers.get("if-range")).toBeNull();
    expect(headers.get("accept-encoding")).toBe("identity");
  });

  it("drops configured range validators when a preview request intentionally has no range", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({
      baseUrl: "https://remote.example.test/",
      headers: { Range: "bytes=0-1", "If-Range": "stale" },
    }, fetchImpl);

    await client.request("GET", "/api/file/preview", undefined, { acceptEncoding: "identity" });

    const headers = new Headers(onlyFetchCall(fetchImpl).init.headers);
    expect(headers.get("range")).toBeNull();
    expect(headers.get("if-range")).toBeNull();
  });

  it("marks decoded streamed responses and removes stale representation headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("decoded bytes", {
      status: 206,
      headers: {
        "content-type": "application/pdf",
        "content-encoding": "gzip",
        "content-length": "31",
        "content-range": "bytes 0-12/100",
      },
    })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);

    const response = await client.request("GET", "/api/file/preview");

    expect(response.bodyDecoded).toBe(true);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["content-range"]).toBe("bytes 0-12/100");
  });

  it("removes stale representation headers after Fetch decodes a compressed JSON response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "31",
      },
    })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);

    const response = await client.requestJson("GET", "/api/projects");

    expect(response.body).toEqual({ ok: true });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
  });
});

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function onlyFetchCall(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): { input: RequestInfo | URL; init: RequestInit } {
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const call = fetchImpl.mock.calls[0];
  if (call === undefined) throw new Error("Expected fetch call");
  const [input, init] = call;
  if (init === undefined) throw new Error("Expected fetch init");
  return { input, init };
}
