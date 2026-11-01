/**
 * Admission barrier for daemon resource changes. Work is counted before its first
 * await, not inferred from SDK flags (which can lag asynchronous startup).
 * The owner must route every affected operation through the same gate before
 * using exclusive admission; this class does not inspect SDK/background state.
 */
export class SessionOperationGate {
  private active = 0;
  private exclusive = false;

  runSync<T>(operation: () => T): T {
    if (this.exclusive) throw new Error("Session resources are reloading; try again shortly");
    this.active++;
    try {
      return operation();
    } finally {
      this.active--;
    }
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.exclusive) throw new Error("Session resources are reloading; try again shortly");
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
    }
  }

  /** Reject, rather than wait for or interrupt, already admitted work. */
  async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.exclusive) throw new Error("Session resources are already reloading");
    if (this.active !== 0) throw new Error("Wait for all session activity to finish before reloading");
    this.exclusive = true;
    try {
      return await operation();
    } finally {
      this.exclusive = false;
    }
  }
}
