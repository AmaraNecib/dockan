import { afterEach, describe, expect, it } from "bun:test";

import { ONBOARDING_DISMISSED_KEY, readOnboardingDismissed, writeOnboardingDismissed } from "./onboarding-state";

function withHiddenStorage(fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage disabled");
    },
  });
  try {
    fn();
  } finally {
    if (original !== undefined) Object.defineProperty(window, "localStorage", original);
  }
}

describe("getting-started dismissal persistence (issue #97)", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("is not dismissed when nothing is stored", () => {
    expect(readOnboardingDismissed()).toBe(false);
  });

  it("remembers an explicit dismissal", () => {
    writeOnboardingDismissed();
    expect(readOnboardingDismissed()).toBe(true);
    expect(window.localStorage.getItem(ONBOARDING_DISMISSED_KEY)).toBe("true");
  });

  it("falls back to shown for a stale stored value", () => {
    window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "legacy");
    expect(readOnboardingDismissed()).toBe(false);
  });

  it("falls back to shown for an explicit non-true value", () => {
    window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "false");
    expect(readOnboardingDismissed()).toBe(false);
  });

  it("shows the panel (does not hide it) when storage is unreadable", () => {
    withHiddenStorage(() => {
      expect(readOnboardingDismissed()).toBe(false);
    });
  });

  it("does not throw when storage refuses the write", () => {
    withHiddenStorage(() => {
      expect(() => writeOnboardingDismissed()).not.toThrow();
    });
  });
});
