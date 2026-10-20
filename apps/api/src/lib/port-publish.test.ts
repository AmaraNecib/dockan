import { describe, expect, it } from "bun:test";

import { PortPublication } from "./port-publish";

/**
 * The publication of the canonical `.dokan-port` needs two facts, and they do
 * not arrive in a fixed order: this instance may be pointed at, and the
 * listener is up. Greptile issue 1 on #298: the old order published from the
 * listen callback and skipped the record when the port was not known yet, so a
 * refused instance that took the folder before a slow bind finished served a
 * port discovery never learned about.
 */
describe("when the canonical port record goes out", () => {
  it("publishes when the folder is owned BEFORE the listener is up (the race)", async () => {
    const published: number[] = [];
    const publication = new PortPublication();
    // the refused instance took the folder on its first tick, before the bind
    // reported its port
    publication.setPublishable();
    // nothing may be published while the port is unknown: the old order's
    // silent skip is the bug
    const running = publication.run(async (port) => void published.push(port));
    await Bun.sleep(20);
    expect(published).toEqual([]);

    // and when the listener finally reports, the record goes out
    publication.setBoundPort(4318);
    await running;
    expect(published).toEqual([4318]);
  });

  it("publishes when the listener is up BEFORE the folder is owned (the normal order)", async () => {
    const published: number[] = [];
    const publication = new PortPublication();
    publication.setBoundPort(4319);
    // a refused start that does not own the folder must not point the proxy at
    // its own listener
    const running = publication.run(async (port) => void published.push(port));
    await Bun.sleep(20);
    expect(published).toEqual([]);

    publication.setPublishable();
    await running;
    expect(published).toEqual([4319]);
  });

  it("publishes exactly once, whichever side reports last", async () => {
    const published: number[] = [];
    const publication = new PortPublication();
    publication.setPublishable();
    publication.setBoundPort(4320);
    await publication.run(async (port) => void published.push(port));
    // a later call (the other side of the race reporting) must not publish again
    await publication.run(async (port) => void published.push(port));
    expect(published).toEqual([4320]);
  });

  it("publishes nothing when the instance may not be pointed at", async () => {
    // a refused start that never takes the folder: the record stays the
    // owner's, and the proxy keeps following it
    const published: number[] = [];
    const publication = new PortPublication();
    publication.setBoundPort(4323);
    const running = publication.run(async (port) => void published.push(port));
    await Bun.sleep(20);
    expect(published).toEqual([]);
    publication.cancel();
    // a cancel releases the waiters: the publication must not start later
    publication.setPublishable();
    await running;
    expect(published).toEqual([]);
  });

  it("carries the publication in flight, so a shutdown can wait for it (Greptile issue 2)", async () => {
    // A shutdown that decides "this process published nothing" while a
    // publication is still waiting for the shared port lock leaves the record
    // behind when it lands, and discovery then points at a dead listener.
    const publication = new PortPublication();
    publication.setPublishable();
    publication.setBoundPort(4321);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let landed = false;
    const running = publication.run(async () => {
      await gate;
      landed = true;
    });
    // the publication is in flight now
    await Bun.sleep(20);
    expect(landed).toBe(false);

    // the shutdown waits for the publication, and does not decide before it
    let settled = false;
    const waiting = publication.settled().then(() => {
      settled = true;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    release();
    await running;
    await waiting;
    expect(landed).toBe(true);
    expect(settled).toBe(true);
  });

  it("settles at once when nothing is in flight", async () => {
    const publication = new PortPublication();
    publication.setPublishable();
    publication.setBoundPort(4322);
    await publication.run(async () => {});
    // a shutdown on a process that already published must not wait for anything
    await publication.settled();
  });
});
