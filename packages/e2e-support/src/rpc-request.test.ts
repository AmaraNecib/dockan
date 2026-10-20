import { describe, expect, it } from "bun:test";

import { postRpcInPage, rpcRequestInit, VAULT_SESSION_STORAGE_KEY } from "./rpc-request";

/**
 * #295 — the request the e2e helpers post is shipped behaviour: the app's own
 * link header (`x-vault-session`) and its credentials mode. Before this, the
 * only proof was a comment in the helper, and deleting the header line left
 * every test green until a vault-mode server refused the seed.
 *
 * The assertions below look at the request the helper would actually send,
 * because they call the same function the helper calls.
 */

/** The fetch calls one test captured. */
interface CapturedFetch {
  url: string;
  init: RequestInit;
}

/** Run `body` with `fetch` stubbed, and hand back what the stub was asked for. */
async function captureFetch(body: () => Promise<void>): Promise<CapturedFetch[]> {
  const calls: CapturedFetch[] = [];
  const original = globalThis.fetch;
  // SAFETY: the stub answers the same JSON the oRPC link answers, and takes
  // the same arguments the real fetch takes; only the network is replaced.
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ json: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

describe("the e2e helper's RPC request (#295)", () => {
  it("carries the vault session header when a token is configured", async () => {
    const init = rpcRequestInit("vault-token-1");
    expect(init.headers["x-vault-session"]).toBe("vault-token-1");

    // and the request the helper posts carries it
    const calls = await captureFetch(async () => {
      await postRpcInPage({ name: "categoriesList", payload: "{}", init });
    });
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-vault-session")).toBe("vault-token-1");
  });

  it("sends no vault header when there is no session", async () => {
    // an empty token means "no session": an empty header VALUE is not the
    // same thing as no header, and the server reads what it gets
    expect("x-vault-session" in rpcRequestInit(null).headers).toBe(false);
    expect("x-vault-session" in rpcRequestInit("").headers).toBe(false);

    const calls = await captureFetch(async () => {
      await postRpcInPage({ name: "categoriesList", payload: "{}", init: rpcRequestInit(null) });
    });
    expect(new Headers(calls[0]!.init.headers).get("x-vault-session")).toBeNull();
  });

  it("posts with the app's credentials mode", async () => {
    // the session cookie is what authenticates a seeded call on a server with
    // the legacy login flow; "include" is the app's own mode
    const calls = await captureFetch(async () => {
      await postRpcInPage({ name: "categoriesList", payload: "{}", init: rpcRequestInit("vault-token-1") });
    });
    expect(calls[0]!.init.credentials).toBe("include");
    expect(rpcRequestInit(null).credentials).toBe("include");
  });

  it("reads the token from the key the app's vault client writes", () => {
    expect(VAULT_SESSION_STORAGE_KEY).toBe("dokan.vault.session");
  });

  it("says WHY a refused call failed, not only its status", async () => {
    // A refusal is the one failure whose cause lives ONLY in the body: the
    // status says "400", the body says which field or precondition the api
    // wanted. Dropping it turns a refused seed into "HTTP 400" with nothing to
    // act on.
    const original = globalThis.fetch;
    // SAFETY: the stub answers the shape the api refuses with — a non-2xx
    // status carrying the app's typed error — and takes the same arguments the
    // real fetch takes; only the network is replaced
    globalThis.fetch = (async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: { message: "CATEGORY_REQUIRED" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const call = postRpcInPage({
        name: "itemsCreateWithStock",
        payload: "{}",
        init: rpcRequestInit(null),
      });
      await expect(call).rejects.toThrow("itemsCreateWithStock failed with HTTP 400");
      // the server's own words: a refused seed says what it wanted
      await expect(call).rejects.toThrow("CATEGORY_REQUIRED");
    } finally {
      globalThis.fetch = original;
    }
  });
});
