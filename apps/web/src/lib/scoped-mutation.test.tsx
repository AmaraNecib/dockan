import { afterEach, expect, it } from "bun:test";
import { MutationCache, QueryClient, QueryClientProvider, type MutationFunctionContext, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";
import { act } from "react";
import { z } from "zod";
import { createRoot } from "react-dom/client";
import { clearAuthLost, markAuthLost } from "./auth-refusal";
import { createCredentialLease, type CredentialLease } from "./credential-lease";
import { orpc, rpcClient } from "./rpc";
import { RpcScopeProvider } from "./rpc-context";
import { useMutation } from "./scoped-mutation";
import { addRecoveryKey, changeVaultPassphrase, clearVaultSessionToken, readVaultSessionToken, removeRecoveryKey, resetVaultPassphrase, storeVaultSessionToken } from "./vault-client";

// SAFETY: only React's test-environment flag is written.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement; client: QueryClient }> = [];

afterEach(() => {
  for (const { root, host, client } of mounted) {
    act(() => { root.unmount(); client.clear(); });
    host.remove();
  }
  mounted.length = 0;
  globalThis.fetch = originalFetch;
  clearVaultSessionToken();
  clearAuthLost();
});

async function mount<TData, TVariables, TContext>(
  options: UseMutationOptions<TData, Error, TVariables, TContext>,
  client: QueryClient,
  lease?: CredentialLease,
): Promise<() => UseMutationResult<TData, Error, TVariables, TContext>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host, client });
  let current!: UseMutationResult<TData, Error, TVariables, TContext>;
  function Probe() {
    current = useMutation(options, client);
    return null;
  }
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RpcScopeProvider binding={{ rpcClient, orpc, lease }}><Probe /></RpcScopeProvider>
      </QueryClientProvider>,
    );
  });
  expect({ mutate: current?.mutate, mutateAsync: current?.mutateAsync }).toEqual({
    mutate: expect.any(Function),
    mutateAsync: expect.any(Function),
  });
  return () => current;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each(["live lease", "unscoped fallback"])("preserves mutation receiver, arguments, result and callback context for %s", async (scope) => {
  const client = new QueryClient();
  const variables = { amount: 17 };
  const optimistic = { previous: 11 };
  const meta = { source: "settings" };
  const mutationKey = ["typed-settings"];
  const order: string[] = [];
  let startupContext!: MutationFunctionContext;
  const current = await mount<string, typeof variables, typeof optimistic>({
    meta,
    mutationKey,
    onMutate: async (input, context) => {
      expect(input).toBe(variables);
      expect(context.client).toBe(client);
      startupContext = context;
      order.push("onMutate");
      await Promise.resolve();
      return optimistic;
    },
    mutationFn: function (this: { meta?: typeof meta; mutationKey?: typeof mutationKey }, input, context) {
      expect(this.meta).toBe(meta);
      expect(this.mutationKey).toBe(mutationKey);
      expect(input).toBe(variables);
      expect(context).toBe(startupContext);
      order.push("mutationFn");
      return Promise.resolve("saved-17");
    },
    onSuccess: (data, input, result, context) => {
      expect(data).toBe("saved-17");
      expect(input).toBe(variables);
      expect(result).toBe(optimistic);
      expect(context).toBe(startupContext);
      order.push("onSuccess");
    },
    onSettled: (data, error, input, result, context) => {
      expect(data).toBe("saved-17");
      expect(error).toBeNull();
      expect(input).toBe(variables);
      expect(result).toBe(optimistic);
      expect(context).toBe(startupContext);
      order.push("onSettled");
    },
  }, client, scope === "live lease" ? createCredentialLease() : undefined);
  await act(async () => {
    expect(await current().mutateAsync(variables, {
      onSuccess: (data, input, result, context) => {
        expect(data).toBe("saved-17");
        expect(input).toBe(variables);
        expect(result).toBe(optimistic);
        expect(context).toEqual(startupContext);
        order.push("per-call onSuccess");
      },
    })).toBe("saved-17");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(order).toEqual(["onMutate", "mutationFn", "onSuccess", "onSettled", "per-call onSuccess"]);
});

it("keeps TanStack's mutation defaults when no mutationFn is supplied", async () => {
  const client = new QueryClient();
  client.setMutationDefaults(["default-function"], { mutationFn: async (value: number) => `default-${value}` });
  const current = await mount<string, number, unknown>({ mutationKey: ["default-function"] }, client);
  await act(async () => {
    expect(await current().mutateAsync(23)).toBe("default-23");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

it.each(["key", "global"] as const)("preserves omitted %s default callbacks and explicit undefined overrides", async (source) => {
  const events: string[] = [];
  const contextValue = { previous: 5 };
  const defaults: UseMutationOptions<unknown, Error, unknown, unknown> = {
    mutationFn: async (value) => { const input = z.number().parse(value); if (input < 0) throw new Error("default refusal"); return `saved-${input}`; },
    onMutate: (value) => { events.push(`mutate-${value}`); return contextValue; },
    onSuccess: (data, value, result) => { expect(result).toBe(contextValue); events.push(`success-${data}-${value}`); },
    onError: (error, value, result) => { expect(result).toBe(contextValue); events.push(`error-${error.message}-${value}`); },
    onSettled: (_data, _error, value, result) => { expect(result).toBe(contextValue); events.push(`settled-${value}`); },
  };
  const client = new QueryClient(source === "global" ? { defaultOptions: { mutations: defaults } } : {});
  if (source === "key") client.setMutationDefaults(["callbacks"], defaults);
  const current = await mount<string, number, typeof contextValue>({ mutationKey: ["callbacks"] }, client, createCredentialLease());
  await act(async () => {
    expect(await current().mutateAsync(9)).toBe("saved-9");
    await expect(current().mutateAsync(-1)).rejects.toThrow("default refusal");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(events).toEqual(["mutate-9", "success-saved-9-9", "settled-9", "mutate--1", "error-default refusal--1", "settled--1"]);
  events.length = 0;
  const overridden = await mount<string, number, typeof contextValue>({ mutationKey: ["callbacks"], onMutate: undefined, onSuccess: undefined, onError: undefined, onSettled: undefined }, client);
  await act(async () => {
    expect(await overridden().mutateAsync(10)).toBe("saved-10");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(events).toEqual([]);
});

it.each(["supplied", "key defaults", "global defaults"] as const)("suppresses retired rejection callbacks but forwards fresh errors with %s", async (source) => {
  const variables = { amount: 41 };
  const optimistic = { previous: 12 };
  const failure = new Error("deferred refusal");
  const entered = deferred();
  let rejectA!: (error: Error) => void;
  const held = new Promise<string>((_resolve, reject) => { rejectA = reject; });
  const oldEvents: string[] = [];
  const freshEvents: string[] = [];
  function options(events: string[], mutationFn: () => Promise<string>): UseMutationOptions<unknown, Error, unknown, unknown> {
    return {
      mutationKey: ["rejection"], mutationFn,
      onMutate: () => optimistic,
      onError: (error, value, result, context) => {
        expect(error).toBe(failure); expect(value).toBe(variables); expect(result).toBe(optimistic);
        expect(context.mutationKey).toEqual(["rejection"]); events.push("error");
      },
      onSettled: (data, error, value, result, context) => {
        expect(data).toBeUndefined(); expect(error).toBe(failure); expect(value).toBe(variables); expect(result).toBe(optimistic);
        expect(context.mutationKey).toEqual(["rejection"]); events.push("settled");
      },
    };
  }
  async function scoped(events: string[], fn: () => Promise<string>, lease: CredentialLease) {
    const defaults = options(events, fn);
    const client = new QueryClient(source === "global defaults" ? { defaultOptions: { mutations: defaults } } : {});
    if (source === "key defaults") client.setMutationDefaults(["rejection"], defaults);
    return mount(source === "supplied" ? defaults : { mutationKey: ["rejection"] }, client, lease);
  }
  const old = await scoped(oldEvents, () => { entered.resolve(); return held; }, createCredentialLease());
  let outcome!: Promise<unknown>;
  await act(async () => {
    outcome = old().mutateAsync(variables).then(() => null, (error: Error) => error);
    await entered.promise;
  });
  markAuthLost(); clearAuthLost();
  const fresh = await scoped(freshEvents, async () => { throw failure; }, createCredentialLease());
  await act(async () => {
    rejectA(failure);
    expect(await outcome).toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(oldEvents).toEqual([]);
  await act(async () => {
    await expect(fresh().mutateAsync(variables)).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(freshEvents).toEqual(["error", "settled"]);
});

const settingsWrites = [
  { name: "change passphrase", run: () => changeVaultPassphrase("old passphrase", "new passphrase"), path: "/api/vault/change-passphrase", method: "POST", authenticated: true },
  { name: "add recovery key", run: addRecoveryKey, path: "/api/vault/recovery-keys", method: "POST", authenticated: true },
  { name: "remove recovery key", run: () => removeRecoveryKey("key-1"), path: "/api/vault/recovery-keys/key-1", method: "DELETE", authenticated: true },
  { name: "reset passphrase", run: () => resetVaultPassphrase("recovery-key", "new passphrase"), path: "/api/vault/reset-passphrase", method: "POST", authenticated: false },
];

for (const startup of ["cache onMutate without caller onMutate", "async caller onMutate"] as const) {
  for (const write of settingsWrites) {
    it(`blocks retired ${write.name} after ${startup}, without borrowing B's credential`, async () => {
      const entered = deferred();
      const release = deferred();
      const requests: Array<{ path: string; method: string | undefined; token: string | null }> = [];
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ path: String(input), method: init?.method, token: new Headers(init?.headers).get("x-vault-session") });
        return Response.json(write.name === "add recovery key" ? { id: "new-key", code: "fresh-recovery-key" } : { ok: true, sessionToken: "rotated-by-B" });
      }, { preconnect: originalFetch.preconnect });
      const holdStartup = async () => {
        entered.resolve();
        await release.promise;
        return { previous: "A" };
      };
      const clientA = new QueryClient({
        mutationCache: new MutationCache(startup === "cache onMutate without caller onMutate" ? { onMutate: holdStartup } : {}),
      });
      const leaseA = createCredentialLease();
      storeVaultSessionToken("credential-A");
      const options: UseMutationOptions<unknown, Error, void, { previous: string }> = { mutationFn: write.run };
      if (startup === "async caller onMutate") options.onMutate = holdStartup;
      const old = await mount(options, clientA, leaseA);
      let pending!: Promise<Error | null>;
      await act(async () => {
        pending = old().mutateAsync(undefined).then(() => null, (error: Error) => error);
        await entered.promise;
      });
      expect(requests).toEqual([]);
      expect(leaseA.isLive()).toBe(true);

      markAuthLost();
      clearAuthLost();
      storeVaultSessionToken("credential-B");
      const leaseB = createCredentialLease();
      const fresh = await mount<unknown, void, unknown>({ mutationFn: write.run }, new QueryClient(), leaseB);
      expect(leaseA.isLive()).toBe(false);
      expect(leaseB.isLive()).toBe(true);
      let outcome: Error | null | undefined;
      await act(async () => {
        clientA.clear();
        release.resolve();
        outcome = await pending;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // This is the counterexample assertion: no A write may reach the real vault transport.
      expect(requests).toEqual([]);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome?.message).toBe("SESSION_SCOPE_RETIRED");
      expect(readVaultSessionToken()).toBe("credential-B");

      await act(async () => {
        await fresh().mutateAsync(undefined);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(requests).toEqual([{ path: write.path, method: write.method, token: write.authenticated ? "credential-B" : null }]);
      expect(readVaultSessionToken()).toBe(write.name === "add recovery key" ? "credential-B" : "rotated-by-B");
    });
  }
}
