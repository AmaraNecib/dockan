import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle } from "lucide-react";
import type { OnboardingProgress } from "@dokan/contracts";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isOnboardingComplete, onboardingSteps } from "./onboarding-steps";

interface GettingStartedPanelProps {
  /** true once dismissed or completed; the panel never renders again. */
  hidden: boolean;
  /** undefined while the progress read is pending or failed. */
  progress: OnboardingProgress | undefined;
  /** true while the progress read has not settled; renders the loading state. */
  isPending: boolean;
  /** true while the dismissal write is in flight; the control is disabled. */
  dismissPending: boolean;
  /** true when the dismissal write did not land: the owner is told, not left guessing. */
  dismissFailed: boolean;
  onDismiss: () => void;
}

/**
 * Loading placeholder sized to the loaded panel: same header padding and type
 * line-heights, same 20px icon column and two-line rows, so the checklist lands
 * without shifting the dashboard (every row is 74px tall, header 80px).
 */
function GettingStartedSkeleton() {
  return (
    <section
      data-testid="getting-started-skeleton"
      aria-hidden="true"
      className="mt-4 rounded border border-border bg-card"
    >
      <div className="border-b border-border p-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-1 h-5 w-56" />
      </div>
      <div className="divide-y divide-border">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-3 p-4">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="mt-1 h-5 w-56" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Getting-started checklist for a brand-new shop (issue 97). It teaches
 * activation, not features: four real links, in the order a shop needs them,
 * each marked done only when its record exists on the server. Once every step
 * is done it disappears for good, and an explicit dismissal is remembered too.
 */
export function GettingStartedPanel({ hidden, progress, isPending, dismissPending, dismissFailed, onDismiss }: GettingStartedPanelProps) {
  const { t } = useTranslation();

  if (hidden) return null;
  if (progress === undefined) return isPending ? <GettingStartedSkeleton /> : null;
  if (isOnboardingComplete(progress)) return null;

  const steps = onboardingSteps(progress);

  return (
    <section
      data-testid="getting-started"
      aria-labelledby="getting-started-title"
      className="mt-4 rounded border border-border bg-card"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h2 id="getting-started-title" className="font-semibold">
            {t("onboardingTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("onboardingHint")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="getting-started-dismiss"
          aria-label={t("onboardingDismissLabel")}
          onClick={onDismiss}
          disabled={dismissPending}
        >
          {t("onboardingDismiss")}
        </Button>
      </div>

      {dismissFailed && (
        <p className="border-b border-border px-4 py-2 text-sm text-destructive" role="alert" data-testid="getting-started-dismiss-error">
          {t("onboardingDismissFailed")}
        </p>
      )}

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
                <span className="mt-1 block text-sm text-muted-foreground">{t(step.hintKey)}</span>
              </span>
              <span className="sr-only">{step.done ? t("onboardingDone") : t("onboardingPending")}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
