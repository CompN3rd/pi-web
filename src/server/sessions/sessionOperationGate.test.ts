import { describe, expect, it, vi } from "vitest";
import { SessionOperationGate } from "./sessionOperationGate.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SessionOperationGate", () => {
  it("counts admission before asynchronous startup and permits concurrent ordinary work", async () => {
    const gate = new SessionOperationGate();
    const first = deferred();
    const second = deferred();
    const a = gate.run(() => first.promise);
    const b = gate.run(() => second.promise);
    const reload = vi.fn();
    await expect(gate.runExclusive(reload)).rejects.toThrow("all session activity");
    first.resolve();
    await a;
    await expect(gate.runExclusive(reload)).rejects.toThrow("all session activity");
    second.resolve();
    await b;
    await gate.runExclusive(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("blocks new work and competing exclusive operations until the transaction settles", async () => {
    const gate = new SessionOperationGate();
    const done = deferred();
    const transaction = gate.runExclusive(() => done.promise);
    const work = vi.fn();
    await expect(gate.run(work)).rejects.toThrow("try again shortly");
    await expect(gate.runExclusive(work)).rejects.toThrow("already reloading");
    expect(work).not.toHaveBeenCalled();
    done.resolve();
    await transaction;
    await gate.run(work);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("releases both kinds of admission after failure (async=%s)", async (asyncFailure) => {
    const gate = new SessionOperationGate();
    const fail = () => {
      if (asyncFailure) return Promise.reject(new Error("failed"));
      throw new Error("failed");
    };
    await expect(gate.run(fail)).rejects.toThrow("failed");
    await expect(gate.runExclusive(fail)).rejects.toThrow("failed");
    await expect(gate.run(() => 42)).resolves.toBe(42);
    await expect(gate.runExclusive(() => 43)).resolves.toBe(43);
  });
});
