import { describe, expect, it } from "vitest";
import { isBrowserRemoteOAuthMachine, isLoopbackHostname, oauthPromptInputType } from "./AuthDialog";

describe("oauthPromptInputType", () => {
  it("renders secret prompts as password inputs and other prompt types as text", () => {
    expect(oauthPromptInputType("secret")).toBe("password");
    expect(oauthPromptInputType("text")).toBe("text");
    expect(oauthPromptInputType("manual_code")).toBe("text");
  });
});

describe("isLoopbackHostname", () => {
  it("treats loopback names as local, case-insensitively and with bracketed IPv6", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("treats every other hostname as remote", () => {
    expect(isLoopbackHostname("pi.example.com")).toBe(false);
    expect(isLoopbackHostname("192.168.1.20")).toBe(false);
    expect(isLoopbackHostname("10.0.0.5")).toBe(false);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
    expect(isLoopbackHostname("my-localhost")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("isBrowserRemoteOAuthMachine", () => {
  it("is remote whenever the flow runs on a federated machine", () => {
    expect(isBrowserRemoteOAuthMachine("fleet-a", "localhost")).toBe(true);
    expect(isBrowserRemoteOAuthMachine("fleet-a", "pi.example.com")).toBe(true);
  });

  it("is remote for the local machine when the page host is not loopback", () => {
    expect(isBrowserRemoteOAuthMachine("local", "pi.example.com")).toBe(true);
    expect(isBrowserRemoteOAuthMachine("local", "10.0.0.5")).toBe(true);
    expect(isBrowserRemoteOAuthMachine("local", "")).toBe(true);
  });

  it("is local only for the local machine on a loopback page host", () => {
    expect(isBrowserRemoteOAuthMachine("local", "localhost")).toBe(false);
    expect(isBrowserRemoteOAuthMachine("local", "127.0.0.1")).toBe(false);
    expect(isBrowserRemoteOAuthMachine("local", "::1")).toBe(false);
  });
});
