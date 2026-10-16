import { useTranslation } from "react-i18next";

import { useGettingStartedVisibility } from "./onboarding-state";

/**
 * Settings escape hatch for the getting-started checklist (issue #115).
 *
 * Dismissing or completing the checklist retires it, and nothing used to bring
 * it back. This control is the way back: turning it on requests a clear of
 * `dismissed` **and** the record-derived `completed` milestone (either one
 * alone keeps `hidden = dismissed || completed` true), so the checklist returns
 * to the dashboard while any step is still open. A half-applied clear is
 * surfaced as an alert, never read as success. A shop that is genuinely
 * complete re-records the milestone on the next observation, which is the
 * intended "nothing left to teach" behaviour rather than a hidden door.
 */
export function GettingStartedSetting() {
  const { t } = useTranslation();
  const { visible, setVisible, isPending, isError, isWriting, writeFailed } = useGettingStartedVisibility();
  // no write against a read we could not confirm, and no second write in flight
  const disabled = isPending || isError || isWriting;

  return (
    <section className="mt-4 grid gap-3 rounded border bg-card p-4" data-testid="settings-getting-started">
      <div>
        <h2 className="font-semibold">{t("settingsGettingStarted")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("settingsGettingStartedHint")}</p>
      </div>

      <label className="flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          role="switch"
          className="size-4 accent-primary"
          checked={visible}
          disabled={disabled}
          onChange={(event) => setVisible(event.target.checked)}
          data-testid="settings-getting-started-toggle"
        />
        {t("settingsGettingStartedToggle")}
      </label>

      {isError && (
        <p className="text-sm text-destructive" role="alert" data-testid="settings-getting-started-read-error">
          {t("settingsGettingStartedUnavailable")}
        </p>
      )}
      {writeFailed && (
        <p className="text-sm text-destructive" role="alert" data-testid="settings-getting-started-write-error">
          {t("settingsGettingStartedFailed")}
        </p>
      )}
    </section>
  );
}
