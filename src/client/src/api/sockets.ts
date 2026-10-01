import type { SessionRef } from "../../../shared/apiTypes";
import { resolveAppWebSocketUrl } from "../appUrl";
import { sessionEventsPath } from "./urls";

export function sessionEvents(session: SessionRef, machineId = "local"): WebSocket {
  return new WebSocket(resolveAppWebSocketUrl(sessionEventsPath(session, machineId)));
}

export function globalSessionEvents(machineId = "local"): WebSocket {
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/sessions/events`));
}

export function realtimeEvents(machineId = "local"): WebSocket {
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/events`));
}

function machinePrefix(machineId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}`;
}
