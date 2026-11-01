import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SessionOperationGate } from "./sessionOperationGate.js";
import { AuthService, type AuthChange } from "./authService.js";

describe("AuthService", () => {
  it("rejects synchronous provider mutations before side effects during exclusive work", async () => {
    const operationGate = new SessionOperationGate();
    const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "original" } });
    const auth = new AuthService({ operationGate, modelRegistry: ModelRegistry.create(authStorage) });
    const changes: AuthChange[] = [];
    auth.subscribe((change) => { changes.push(change); });
    await operationGate.runExclusive(() => {
      expect(() => auth.saveApiKey("anthropic", "replacement")).toThrow("reloading");
      expect(() => auth.logoutProvider("anthropic")).toThrow("reloading");
      expect(() => auth.authProviders("login")).toThrow("reloading");
      expect(() => auth.startOAuthLogin("unknown")).toThrow("reloading");
      expect(() => { auth.dispose(); }).toThrow("reloading");
    });
    expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "original" });
    expect(changes).toEqual([]);
    auth.saveApiKey("anthropic", "replacement");
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("saves API keys and emits a global auth change", () => {
    const { auth, authStorage, changes } = createAuthService();

    expect(auth.saveApiKey("anthropic", "sk-test")).toEqual({ accepted: true });

    expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-test" });
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("logs out providers and emits the removed provider id", () => {
    const { auth, authStorage, changes } = createAuthService({ anthropic: { type: "api_key", key: "sk-test" } });

    expect(auth.logoutProvider("anthropic")).toEqual({ accepted: true });

    expect(authStorage.get("anthropic")).toBeUndefined();
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    auth.dispose();
  });

  it("rejects blank API keys", () => {
    const { auth, changes } = createAuthService();

    expect(() => { auth.saveApiKey("anthropic", "   "); }).toThrow("API key is required");
    expect(changes).toEqual([]);
    auth.dispose();
  });
});

function createAuthService(data: Parameters<typeof AuthStorage.inMemory>[0] = {}) {
  const authStorage = AuthStorage.inMemory(data);
  const modelRegistry = ModelRegistry.create(authStorage);
  const auth = new AuthService({ modelRegistry });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, authStorage, changes };
}
