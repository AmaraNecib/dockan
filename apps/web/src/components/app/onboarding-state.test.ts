import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Dismissal/completion persistence (issue #97). Since the #97 follow-up these
 * preferences live SERVER-SIDE (the packaged shell's origin changes each
 * launch, so localStorage was a wipe). The seams keep their names; the guard
 * moved into the preferences client, and this suite proves it still holds.
 */

let store: Record<string, string>;
let failRead = false;
let failWrite = false;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => {
      if (failRead) throw new Error("PREFERENCES_READ_FAILED");
      return { values: { ...store } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      if (failWrite) throw new Error("PREFERENCES_WRITE_FAILED");
      store[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

const {
  ONBOARDING_COMPLETED_KEY,
  ONBOARDING_DISMISSED_KEY,
  parseOnboardingFlag,
  readOnboardingCompleted,
  readOnboardingDismissed,
  serializeOnboardingFlag,
  writeOnboardingCompleted,
  writeOnboardingDismissed,
} = await import("./onboarding-state");

describe("getting-started preference persistence (issue #97)", () => {
  beforeEach(() => {
    store = {};
    failRead = false;
    failWrite = false;
  });

  it("is not dismissed when nothing is stored", async () => {
    expect(await readOnboardingDismissed()).toBe(false);
  });

  it("remembers an explicit dismissal in the server preference store", async () => {
    await writeOnboardingDismissed();
    expect(await readOnboardingDismissed()).toBe(true);
    expect(store[ONBOARDING_DISMISSED_KEY]).toBe("true");
  });

  it("falls back to shown for a stale stored value", async () => {
    store[ONBOARDING_DISMISSED_KEY] = "legacy";
    expect(await readOnboardingDismissed()).toBe(false);
  });

  it("falls back to shown for an explicit non-true value", async () => {
    store[ONBOARDING_DISMISSED_KEY] = "false";
    expect(await readOnboardingDismissed()).toBe(false);
  });

  it("shows the panel (does not hide it) when the preference read fails", async () => {
    failRead = true;
    expect(await readOnboardingDismissed()).toBe(false);
  });

  it("does not throw when the preference write fails", async () => {
    failWrite = true;
    await expect(writeOnboardingDismissed()).resolves.toBeUndefined();
  });

  it("does not report completion when nothing is stored", async () => {
    expect(await readOnboardingCompleted()).toBe(false);
  });

  it("remembers completion so the panel never returns", async () => {
    await writeOnboardingCompleted();
    expect(await readOnboardingCompleted()).toBe(true);
    expect(store[ONBOARDING_COMPLETED_KEY]).toBe("true");
  });

  it("does not throw when the completion write fails", async () => {
    failWrite = true;
    await expect(writeOnboardingCompleted()).resolves.toBeUndefined();
  });

  it("parses only the explicit true flag", () => {
    expect(parseOnboardingFlag("true")).toBe(true);
    expect(parseOnboardingFlag("false")).toBe(false);
    expect(parseOnboardingFlag("legacy")).toBe(false);
    expect(parseOnboardingFlag(undefined)).toBe(false);
    expect(serializeOnboardingFlag(true)).toBe("true");
    expect(serializeOnboardingFlag(false)).toBe("false");
  });
});
