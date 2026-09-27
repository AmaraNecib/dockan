import { describe, expect, it } from "bun:test";
import type { OnboardingProgress } from "@dokan/contracts";

import { isOnboardingComplete, onboardingSteps } from "./onboarding-steps";

const NONE: OnboardingProgress = { hasItems: false, hasPurchase: false, hasSale: false, hasDebt: false };

describe("getting-started completion logic (issue #97)", () => {
  it("keeps step 1 pending on an empty shop", () => {
    const steps = onboardingSteps(NONE);
    expect(steps.map((step) => step.id)).toEqual(["items", "purchase", "sale", "debts"]);
    expect(steps.map((step) => step.done)).toEqual([false, false, false, false]);
    expect(isOnboardingComplete(NONE)).toBe(false);
  });

  it("completes step 1 only once items exist", () => {
    const steps = onboardingSteps({ ...NONE, hasItems: true });
    expect(steps.map((step) => step.done)).toEqual([true, false, false, false]);
    expect(isOnboardingComplete({ ...NONE, hasItems: true })).toBe(false);
  });

  it("completes step 2 once a purchase exists", () => {
    const steps = onboardingSteps({ ...NONE, hasItems: true, hasPurchase: true });
    expect(steps.map((step) => step.done)).toEqual([true, true, false, false]);
  });

  it("completes step 3 once a sale exists", () => {
    const steps = onboardingSteps({ ...NONE, hasItems: true, hasPurchase: true, hasSale: true });
    expect(steps.map((step) => step.done)).toEqual([true, true, true, false]);
  });

  it("completes step 4 once a debt exists", () => {
    const all: OnboardingProgress = { hasItems: true, hasPurchase: true, hasSale: true, hasDebt: true };
    const steps = onboardingSteps(all);
    expect(steps.map((step) => step.done)).toEqual([true, true, true, true]);
    expect(isOnboardingComplete(all)).toBe(true);
  });

  it("stays incomplete while any single step is open", () => {
    expect(isOnboardingComplete({ hasItems: false, hasPurchase: true, hasSale: true, hasDebt: true })).toBe(false);
    expect(isOnboardingComplete({ hasItems: true, hasPurchase: false, hasSale: true, hasDebt: true })).toBe(false);
    expect(isOnboardingComplete({ hasItems: true, hasPurchase: true, hasSale: false, hasDebt: true })).toBe(false);
    expect(isOnboardingComplete({ hasItems: true, hasPurchase: true, hasSale: true, hasDebt: false })).toBe(false);
  });

  it("points each step at the screen where it is completed, in shop order", () => {
    const steps = onboardingSteps(NONE);
    expect(steps.map((step) => step.to)).toEqual(["/items", "/purchase", "/sale", "/debts"]);
    expect(steps.map((step) => step.labelKey)).toEqual([
      "onboardingStepItems",
      "onboardingStepPurchase",
      "onboardingStepSale",
      "onboardingStepDebts",
    ]);
  });
});
