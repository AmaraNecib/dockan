import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle } from "lucide-react";
import type { OnboardingProgress } from "@dokan/contracts";

import { Button } from "@/components/ui/button";
import { isOnboardingComplete, onboardingSteps } from "./onboarding-steps";
import { readOnboardingDismissed, writeOnboardingDismissed } from "./onboarding-state";

interface GettingStartedPanelProps {
  progress: OnboardingProgress;
}

/**
 * Getting-started checklist for a brand-new shop (issue 97). It teaches
 * activation, not features: four real links, in the order a shop needs them,
 * each marked done only when its record exists on the server. It disappears
 * once every step is done and stays gone after an explicit dismissal.
 */
export function GettingStartedPanel({ progress }: GettingStartedPanelProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(readOnboardingDismissed);

  if (dismissed || isOnboardingComplete(progress)) return null;

  const steps = onboardingSteps(progress);

  function dismiss() {
    writeOnboardingDismissed();
    setDismissed(true);
  }

  return (
    <section
      data-testid="getting-started"
      aria-labelledby="getting-started-title"
      className="mt-4 rounded border border-border bg-card"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h2 id="getting-started-title" className="text-base font-semibold">
            {t("onboardingTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("onboardingHint")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="getting-started-dismiss"
          onClick={dismiss}
        >
          {t("onboardingDismiss")}
        </Button>
      </div>

      <ol className="divide-y divide-border">
        {steps.map((step) => (
          <li key={step.id} data-testid="getting-started-step" data-state={step.done ? "done" : "pending"}>
            <Link
              to={step.to}
              className="group flex items-center gap-3 p-4 transition-colors hover:bg-muted"
            >
              {step.done ? (
                <CheckCircle2 size={20} aria-hidden="true" className="shrink-0 text-primary" />
              ) : (
                <Circle size={20} aria-hidden="true" className="shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium group-hover:underline">{t(step.labelKey)}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">{t(step.hintKey)}</span>
              </span>
              <span className="sr-only">{step.done ? t("onboardingDone") : t("onboardingPending")}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
