import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import {
  backupRestoreAvailable, BackupRestoreError, cancelRestoreBackup, chooseRestoreBackup,
  confirmRestoreBackup, previewRestoreBackup, readRestoreOutcome,
  type RestoreCredential, type RestoreErrorKey, type RestoreOutcome, type RestorePreview, type RestoreSelection,
} from "@/lib/backup-restore";

function credential(secret: string, recovery: boolean): RestoreCredential {
  return recovery ? { recoveryKey: secret } : { passphrase: secret };
}

/** Native-owned outcome survives the locked restart. No secret is persisted. */
export function BackupRestoreOutcome() {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);
  useEffect(() => {
    let alive = true;
    void readRestoreOutcome().then(result => { if (alive) setOutcome(result); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!outcome) return null;
  return <aside className="my-4 grid gap-2 border-y py-4 text-sm" data-testid="restore-outcome">
    <p role="status" className="font-semibold">{t(outcome.status === "restored" ? "restoreSucceeded" : outcome.status === "rolled-back" ? "restoreFailedSafe" : "restoreNotReplaced")}</p>
    <p>{t(outcome.status === "restored" ? "restoreUnlockIncoming" : "restoreUnlockOriginal")}</p>
    <p>{t("restoreSelectedPreserved")}</p>
    <p>{t(outcome.safetyPath ? "restoreSafetyFile" : "restoreSafetyDirectory")}</p>
    <bdi dir="ltr" className="break-all text-xs">{outcome.safetyPath ?? outcome.safetyDirectory}</bdi>
  </aside>;
}

/** Credentials stay out of Query/mutation caches and are cleared on cancel. */
export function BackupRestore() {
  const { t, i18n } = useTranslation();
  const [selection, setSelection] = useState<RestoreSelection | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [currentSecret, setCurrentSecret] = useState("");
  const [currentRecovery, setCurrentRecovery] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<"choose" | "preview" | "cancel" | "replace" | null>(null);
  const [error, setError] = useState<RestoreErrorKey | null>(null);
  const dispatching = useRef(false);
  const navigating = useRef(false);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const currentInput = useRef<HTMLInputElement>(null);
  const backupError = !preview && (error === "restoreRefused" || error === "restoreSecretRequired");
  const currentError = error === "restoreCurrentInvalid";
  const [showPreviousOutcome, setShowPreviousOutcome] = useState(true);
  const desktop = backupRestoreAvailable();

  useEffect(() => { if (selection && !preview) backupInput.current?.focus(); }, [selection, preview]);
  useEffect(() => { if (preview) confirmationHeading.current?.focus(); }, [preview]);
  useEffect(() => {
    if (backupError) backupInput.current?.focus();
    else if (currentError) currentInput.current?.focus();
    else if (error) errorMessage.current?.focus();
  }, [error, backupError, currentError]);

  function clear() {
    setSelection(null); setPreview(null); setSecret(""); setCurrentSecret("");
    setRecovery(false); setCurrentRecovery(false); setConfirmed(false);
  }
  async function run(kind: NonNullable<typeof pending>, work: () => Promise<void>) {
    if (dispatching.current) return;
    dispatching.current = true; setPending(kind); setError(null);
    try { await work(); }
    catch (reason) {
      setError(reason instanceof BackupRestoreError ? reason.key : "restoreRefused");
      if (kind === "replace") { setCurrentSecret(""); setConfirmed(false); }
    } finally { if (!navigating.current) { dispatching.current = false; setPending(null); } }
  }
  const busy = pending !== null;
  const fileTime = preview ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(preview.fileModifiedAt)) : "";
  return <section aria-labelledby="restore-title" className="mt-8 grid min-w-0 gap-4 border-t pt-6" data-testid="backup-restore">
    <h2 id="restore-title" className="text-lg font-semibold">{t("restoreTitle")}</h2>
    <p className="max-w-prose text-sm text-muted-foreground">{t("restoreHint")}</p>
    {showPreviousOutcome && <BackupRestoreOutcome />}
    {!selection && <div><Button ref={chooseButton} type="button" variant="outline" disabled={!desktop || busy} onClick={() => {
      void run("choose", async () => { clear(); const chosen = await chooseRestoreBackup(); setSelection(chosen); if (chosen) setShowPreviousOutcome(false); });
    }}>{pending === "choose" ? t("restoreChoosing") : t("restoreChoose")}</Button></div>}
    {!desktop && <p className="text-sm text-muted-foreground">{t("restoreDesktopOnly")}</p>}
    {selection && <>
      <p className="break-all text-sm text-muted-foreground">{t("restoreSelected")} <bdi dir="ltr" className="font-medium text-foreground">{selection.name}</bdi></p>
      {!preview ? <form className="grid max-w-xl gap-3" onSubmit={event => {
        event.preventDefault();
        if (!secret) { setError("restoreSecretRequired"); return; }
        void run("preview", async () => { setPreview(await previewRestoreBackup(selection.id, credential(secret, recovery))); });
      }}>
        <label className="grid gap-1 text-sm" htmlFor="restore-backup-secret">{t(recovery ? "restoreBackupRecovery" : "restoreBackupPassphrase")}
          <PasswordInput id="restore-backup-secret" ref={backupInput} value={secret} onChange={event => { setSecret(event.target.value); if (backupError) setError(null); }} disabled={busy} autoComplete="off" aria-invalid={backupError} aria-describedby={backupError ? "restore-error" : undefined} required />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recovery} disabled={busy} onChange={event => { setRecovery(event.target.checked); setSecret(""); setError(null); backupInput.current?.focus(); }} />{t("restoreUseRecovery")}</label>
        <div><Button type="submit" disabled={busy || !secret}>{pending === "preview" ? t("restoreChecking") : t("restoreInspect")}</Button></div>
      </form> : <div className="grid max-w-xl gap-3" data-testid="restore-preview">
        <dl className="grid gap-4 border-y py-4 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">{t("restoreFileTime")}</dt><dd><time dateTime={preview.fileModifiedAt}>{fileTime}</time></dd></div>
          <div><dt className="text-muted-foreground">{t("restoreSchema")}</dt><dd><bdi>{preview.schemaVersion} / {preview.supportedSchemaVersion}</bdi></dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">{t("restoreTimeCaveat")}</p>
        <p className="text-sm">{t(preview.schemaVersion < preview.supportedSchemaVersion ? "restoreWillMigrate" : "restoreCompatible")}</p>
        <h3 tabIndex={-1} ref={confirmationHeading} className="mt-4 text-base font-semibold">{t("restoreConfirmTitle")}</h3>
        <p className="text-sm">{t("restoreConfirmHint")}</p>
        <form className="grid gap-3" onSubmit={event => {
          event.preventDefault();
          if (!confirmed || !currentSecret || dispatching.current) return;
          void run("replace", async () => {
            await confirmRestoreBackup(selection.id, preview.sha256, credential(secret, recovery), credential(currentSecret, currentRecovery));
            setSecret(""); setCurrentSecret("");
            // The native command navigates to a freshly verified locked gate.
            // Keep duplicate submissions blocked until that navigation commits.
            navigating.current = true;
          });
        }}>
          <label className="grid gap-1 text-sm" htmlFor="restore-current-secret">{t(currentRecovery ? "restoreCurrentRecovery" : "restoreCurrentPassphrase")}
            <PasswordInput id="restore-current-secret" ref={currentInput} value={currentSecret} onChange={event => { setCurrentSecret(event.target.value); if (currentError) setError(null); }} disabled={busy} autoComplete="off" aria-invalid={currentError} aria-describedby={currentError ? "restore-error" : undefined} required />
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={currentRecovery} disabled={busy} onChange={event => { setCurrentRecovery(event.target.checked); setCurrentSecret(""); setError(null); currentInput.current?.focus(); }} />{t("restoreUseCurrentRecovery")}</label>
          <label className="flex items-start gap-2 text-sm" htmlFor="restore-confirm"><input className="mt-1" id="restore-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{t("restoreConfirmCheck")}</label>
          <div><Button type="submit" variant="destructive" disabled={busy || !confirmed || !currentSecret}>{pending === "replace" ? t("restoreReplacing") : t("restoreReplace")}</Button></div>
        </form>
      </div>}
      <div><Button type="button" variant="outline" disabled={busy} onClick={() => {
        void run("cancel", async () => { await cancelRestoreBackup(selection.id); clear(); chooseButton.current?.focus(); });
      }}>{t("restoreCancel")}</Button></div>
    </>}
    {pending && <p role="status" className="text-sm">{t(pending === "replace" ? "restoreWait" : "restoreWorking")}</p>}
    {error && <p id="restore-error" role="alert" tabIndex={-1} ref={errorMessage} className="text-sm text-destructive">{t(error)}</p>}
  </section>;
}
