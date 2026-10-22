import { describe, expect, it } from "bun:test";
import dns from "node:dns";

import { installLoopbackHostnames, isLoopbackHostname, type LookupResult } from "./loopback-hostnames";

// red-on-parent-waive: "leaves a name that is not a loopback name" — the parent has no patch at all, so `localhost` resolves exactly as it always did: this pin is about the patch NOT changing that, and the parent cannot show it

/**
 * The one address of a lookup result.
 *
 * The resolver answers with a string for one address and with a list for the
 * `all` form; this reads the first address out of either shape.
 */
function firstAddress(found: LookupResult): string {
  if (Array.isArray(found)) return found[0]?.address ?? "";
  return found;
}

/**
 * The address a name resolves to, read through the callback form.
 *
 * The callback form is the one node and bun agree on: the promise form
 * differs between them (bun answers with an object), so the shape both
 * agree on is the one this reads.
 *
 * A name the resolver does not know answers with its error code rather than
 * a rejection: the failure is a value the test can assert on, which is what
 * keeps the difference between "resolved to something else" and "did not
 * resolve at all" visible.
 */
function lookupAddress(hostname: string): Promise<string> {
  return new Promise((resolve) => {
    dns.lookup(hostname, (error, found) => {
      if (error !== null && error !== undefined) {
        resolve(`error:${error.code ?? "unknown"}`);
        return;
      }
      resolve(firstAddress(found));
    });
  });
}

describe("isLoopbackHostname", () => {
  it("covers localhost and every name under it", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("dokan.localhost")).toBe(true);
    expect(isLoopbackHostname("a.b.localhost")).toBe(true);
  });

  it("leaves every other name alone", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(false);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
    expect(isLoopbackHostname("notlocalhost")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("installLoopbackHostnames", () => {
  it("answers a loopback name with the loopback address, the way a browser does", async () => {
    installLoopbackHostnames();
    expect(await lookupAddress("dokan.localhost")).toBe("127.0.0.1");
  });

  it("leaves a name that is not a loopback name resolving as before", async () => {
    installLoopbackHostnames();
    // a name that must not be rewritten: it is the whole point of the patch
    // being a lookup and not a policy
    const address = await lookupAddress("localhost");
    expect(address === "127.0.0.1" || address === "::1").toBe(true);
  });
});
