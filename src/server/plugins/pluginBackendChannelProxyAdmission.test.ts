import { expect, it } from "vitest";
import { PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES, serializePluginBackendChannelErrorEnvelope } from "../../shared/pluginBackendProtocol.js";
import { PluginBackendChannelProxyAdmissionError, PluginBackendChannelProxyAdmissionPool } from "./pluginBackendChannelProxyAdmission.js";

it("keeps admission errors serializable even if future callers supply oversized Unicode identities", () => {
  const pool = new PluginBackendChannelProxyAdmissionPool({ maxTotal: 1 });
  const scope = { authorityId: "remote", pluginId: "terminal", projectId: "project", workspaceId: "😀".repeat(2000) };
  const reservation = pool.admit(scope);
  let failure: unknown;
  try { pool.admit(scope); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PluginBackendChannelProxyAdmissionError);
  if (!(failure instanceof PluginBackendChannelProxyAdmissionError)) throw new Error("Expected admission failure");
  expect(Buffer.byteLength(failure.message, "utf8")).toBeLessThanOrEqual(PLUGIN_BACKEND_CHANNEL_ERROR_MESSAGE_MAX_BYTES);
  expect(() => serializePluginBackendChannelErrorEnvelope(failure.code, failure.message)).not.toThrow();
  expect(pool.activeCount).toBe(1);
  reservation.release();
  expect(pool.activeCount).toBe(0);
});
