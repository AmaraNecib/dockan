/**
 * When the canonical port record may be published (#277).
 *
 * The record needs two facts: this instance may be pointed at (it owns the
 * data folder, or it is a plaintext start that owns its port outright), and the
 * listener is up on a known port. They do not arrive in a fixed order. A
 * refused instance that takes the folder can win the race against a slow bind
 * (a DOKAN_HOST lookup that outlives the first reclaim tick), and the old
 * order — publish from the listen callback, skip when the port is not known
 * yet — left that instance serving a port discovery never learned about, with
 * the proxy still following the previous one (Greptile issue 1).
 *
 * So the order is removed rather than handled: there is ONE publication site
 * (main.ts calls `run` once), and it fires when both facts are true, whichever
 * arrives last.
 *
 * The class also carries the publication in flight, so a shutdown can wait for
 * it to land before deciding what to withdraw (Greptile issue 2). A record
 * written a moment before the exit must still be withdrawn, or discovery points
 * at a listener that is gone.
 */
export class PortPublication {
  private publishable = false;
  private boundPort: number | undefined;
  private published = false;
  private cancelled = false;
  private inFlight: Promise<void> | undefined;
  private ready: Promise<number | undefined> | undefined;
  private resolveReady: ((port: number | undefined) => void) | undefined;

  /**
   * The canonical record may point at this instance: it owns the data folder
   * (it took the lock, or reclaimed it), or it is a plaintext start that owns
   * its port outright. A refused instance that is still waiting is neither.
   */
  setPublishable(): void {
    this.publishable = true;
    this.resolveIfReady();
  }

  /** The listener is up on this port. */
  setBoundPort(port: number): void {
    this.boundPort = port;
    this.resolveIfReady();
  }

  /**
   * Publish the canonical record, as soon as both facts are known. The
   * publication is carried while it runs, so a shutdown can wait for it.
   */
  async run(publish: (port: number) => Promise<void>): Promise<void> {
    const port = await this.readyPort();
    if (port === undefined || this.published || this.cancelled) return;
    this.published = true;
    this.inFlight = publish(port);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  /**
   * Give up on a publication that has not started yet. A shutdown calls this
   * before it decides what to withdraw: a record written after that decision
   * would outlive the listener.
   */
  cancel(): void {
    this.cancelled = true;
    // release the waiter: a cancelled publication must not start later
    const resolve = this.resolveReady;
    if (resolve === undefined) return;
    this.resolveReady = undefined;
    resolve(undefined);
  }

  /**
   * Wait for the publication in flight, if any, to land. A shutdown calls this
   * before deciding what to withdraw (Greptile issue 2).
   */
  async settled(): Promise<void> {
    const pending = this.inFlight;
    if (pending === undefined) return;
    try {
      await pending;
    } catch {
      /* the publisher reports the failure itself and stops the process */
    }
  }

  /** The port, once both facts are known. */
  private readyPort(): Promise<number | undefined> {
    if (this.ready === undefined) {
      this.ready = new Promise<number | undefined>((resolve) => {
        this.resolveReady = resolve;
      });
      this.resolveIfReady();
    }
    return this.ready;
  }

  private resolveIfReady(): void {
    const resolve = this.resolveReady;
    const port = this.boundPort;
    if (resolve === undefined || !this.publishable || port === undefined) return;
    this.resolveReady = undefined;
    resolve(port);
  }
}
