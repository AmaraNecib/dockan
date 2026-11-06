/** Admission and drain for HTTP work and detached encrypted backup jobs. */
export class VaultWriterDrain {
  private active = 0;
  private stopping = false;
  private drained: (() => void) | undefined;
  private stopped: Promise<void> | undefined;

  get closed(): boolean { return this.stopping; }

  async run<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("VAULT_STOPPING");
    this.active += 1;
    try { return await work(); } finally {
      this.active -= 1;
      if (this.active === 0) this.drained?.();
    }
  }

  stop(close: () => Promise<void>): Promise<void> {
    if (this.stopped !== undefined) return this.stopped;
    // Stop admission synchronously, before waiting for any admitted operation.
    this.stopping = true;
    const wait = this.active === 0 ? Promise.resolve() : new Promise<void>((resolve) => { this.drained = resolve; });
    this.stopped = wait.then(close);
    return this.stopped;
  }
}
