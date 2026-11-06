import { useQuery } from "@tanstack/react-query";
import { useMutation } from "../lib/scoped-mutation";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { useRpc } from "../lib/rpc-context";
import { tError } from "../lib/i18n";
import { backupRevealAvailable, BackupRevealError, revealBackup } from "../lib/backup-reveal";

function externalOutcomeKey(status: { lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null; lastPath: string | null } | undefined): string {
  return JSON.stringify([status?.lastAttemptAt, status?.lastSuccessAt, status?.lastError, status?.lastPath]);
}

/**
 * Backups (ticket 13): one manual export button — a checkpoint+copy of the
 * shop's database the owner can move to a USB stick. The daily copy happens
 * automatically on api startup; this page only triggers the same seam by hand
 * and reports where the file landed.
 */
export function BackupsPage() {
  const { orpc } = useRpc();
  const { t } = useTranslation();
  const [awaitingExternalOutcome, setAwaitingExternalOutcome] = useState(false);
  const externalAttemptBaseline = useRef<string | null>(null);
  const externalStatus = useQuery({
    ...orpc.externalBackupStatus.queryOptions(),
    refetchInterval: (query) => awaitingExternalOutcome
      && externalOutcomeKey(query.state.data) === externalAttemptBaseline.current
      ? 5_000
      : false,
  });
  const currentExternalOutcomeKey = externalOutcomeKey(externalStatus.data);
  useEffect(() => {
    if (awaitingExternalOutcome && currentExternalOutcomeKey !== externalAttemptBaseline.current) {
      setAwaitingExternalOutcome(false);
    }
  }, [awaitingExternalOutcome, currentExternalOutcomeKey]);
  const backup = useMutation(orpc.backupManual.mutationOptions({
    onSuccess: () => {
      if (externalStatus.data?.destination) {
        externalAttemptBaseline.current = externalOutcomeKey(externalStatus.data);
        setAwaitingExternalOutcome(true);
        void externalStatus.refetch();
      }
    },
  }));
  const externalDevice = useQuery(orpc.externalBackupDevice.queryOptions());
  const [destination, setDestination] = useState("");
  const [destinationEdited, setDestinationEdited] = useState(false);
  const saveDestination = useMutation(orpc.externalBackupDestinationSet.mutationOptions({
    onSuccess: (saved) => {
      setDestination(saved.destination ?? "");
      setDestinationEdited(false);
      void externalStatus.refetch();
      void externalDevice.refetch();
    },
  }));
  const runExternal = useMutation(orpc.externalBackupRun.mutationOptions({
    onSuccess: () => { void externalStatus.refetch(); },
  }));
  const reveal = useMutation({ mutationFn: revealBackup });
  const dispatching = useRef(false);
  const exportButton = useRef<HTMLButtonElement>(null);
  const revealError = reveal.error instanceof BackupRevealError ? reveal.error.key : "backupsRevealFailed";
  const missing = reveal.isError && revealError === "backupsRevealMissing";
  const desktop = backupRevealAvailable();

  useEffect(() => {
    if (missing) exportButton.current?.focus();
  }, [missing]);

  return (
    <section>
      <h1 className="text-xl font-bold">{t("backupsTitle")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("backupsHint")}</p>

      <div className="mt-4 grid gap-3 rounded border bg-card p-4">
        <form data-testid="external-backup-panel" className="grid gap-2 border-b pb-4" onSubmit={(event) => {
          event.preventDefault();
          saveDestination.mutate({ destination: destinationEdited ? destination : externalStatus.data?.destination ?? destination });
        }}>
          <label htmlFor="external-backup-destination" className="text-sm font-medium">{t("backupsExternalDestination")}</label>
          <input
            id="external-backup-destination"
            data-testid="external-backup-destination"
            dir="ltr"
            className="rounded border bg-background px-3 py-2 font-mono text-sm"
            value={destinationEdited ? destination : externalStatus.data?.destination ?? destination}
            disabled={saveDestination.isPending}
            onChange={(event) => { setDestination(event.currentTarget.value); setDestinationEdited(true); }}
            placeholder={t("backupsExternalDestinationHint")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saveDestination.isPending || externalStatus.isPending || (!destinationEdited && !externalStatus.data?.destination)}>{t("backupsExternalSave")}</Button>
            <Button type="button" variant="outline" disabled={!destinationEdited || saveDestination.isPending} onClick={() => { setDestination(externalStatus.data?.destination ?? ""); setDestinationEdited(false); }}>
              {t("backupsExternalCancel")}
            </Button>
            <Button type="button" variant="outline" disabled={!externalStatus.data?.destination || saveDestination.isPending} onClick={() => saveDestination.mutate({ destination: null })}>
              {t("backupsExternalReset")}
            </Button>
            <Button type="button" variant="outline" disabled={!externalStatus.data?.destination || runExternal.isPending} onClick={() => runExternal.mutate(undefined)}>
              {runExternal.isPending ? t("backupsBusy") : t("backupsExternalRun")}
            </Button>
          </div>
          {externalStatus.isPending && <p role="status" className="text-sm">{t("backupsExternalLoading")}</p>}
          {externalStatus.isError && <p role="alert" className="text-sm text-destructive">{t("backupsExternalStatusFailed")}</p>}
          {externalStatus.data?.destination && <p dir="ltr" className="break-all font-mono text-xs">{externalStatus.data.destination}</p>}
          {externalStatus.data?.lastSuccessAt && <div className="text-sm" data-testid="external-backup-success">
            <p role="status">{t("backupsExternalSuccess", { at: externalStatus.data.lastSuccessAt })}</p>
            {externalStatus.data.lastPath && <p dir="ltr" className="mt-1 break-all font-mono text-xs">{externalStatus.data.lastPath}</p>}
          </div>}
          {externalStatus.data?.lastError && <p role="alert" className="text-sm text-destructive">{t(`backupsExternalError_${externalStatus.data.lastError}`)}</p>}
          {externalDevice.data === "same" && <p role="status" className="text-sm text-warning">{t("backupsExternalSameDrive")}</p>}
          {externalDevice.isError && <p className="text-sm text-muted-foreground">{t("backupsExternalDriveUnknown")}</p>}
          {externalDevice.data === "unknown" && <p className="text-sm text-muted-foreground">{t("backupsExternalDriveUnknown")}</p>}
          {saveDestination.isError && <p role="alert" className="text-sm text-destructive">{tError(saveDestination.error.message)}</p>}
          {runExternal.isError && <p role="alert" className="text-sm text-destructive">{tError(runExternal.error.message)}</p>}
        </form>
        <div>
          <Button
            ref={exportButton}
            data-testid="backup-export"
            onClick={() => {
              if (dispatching.current) return;
              dispatching.current = true;
              reveal.reset();
              backup.mutate(undefined, { onSettled: () => { dispatching.current = false; } });
            }}
            disabled={backup.isPending || reveal.isPending}
          >
            {backup.isPending ? t("backupsBusy") : t("backupsExport")}
          </Button>
        </div>
        {backup.isError && (
          <p className="text-sm text-destructive" role="alert">
            {tError(backup.error.message)}
          </p>
        )}
        {reveal.isError && (
          <p className="text-sm text-destructive" role="alert">{t(revealError)}</p>
        )}
        {backup.isSuccess && !missing && (
          <div className="rounded bg-success/10 p-3 text-sm text-success" data-testid="backup-done">
            <p role="status">{t("backupsDone")}</p>
            <p dir="ltr" className="mt-1 break-all font-mono text-xs">
              {backup.data.path}
            </p>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => {
                if (dispatching.current) return;
                dispatching.current = true;
                reveal.mutate(backup.data.path, { onSettled: () => { dispatching.current = false; } });
              }}
              disabled={!desktop || reveal.isPending}
            >
              {reveal.isPending ? t("backupsRevealing") : t("backupsReveal")}
            </Button>
            {!desktop && <p className="mt-2 text-muted-foreground">{t("backupsRevealDesktopOnly")}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
