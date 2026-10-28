import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";
import { backupRevealAvailable, BackupRevealError, revealBackup } from "../lib/backup-reveal";

/**
 * Backups (ticket 13): one manual export button — a checkpoint+copy of the
 * shop's database the owner can move to a USB stick. The daily copy happens
 * automatically on api startup; this page only triggers the same seam by hand
 * and reports where the file landed.
 */
export function BackupsPage() {
  const { t } = useTranslation();
  const backup = useMutation(orpc.backupManual.mutationOptions());
  const reveal = useMutation({ mutationFn: revealBackup });
  const revealError = reveal.error instanceof BackupRevealError ? reveal.error.key : "backupsRevealFailed";
  const missing = reveal.isError && revealError === "backupsRevealMissing";
  const desktop = backupRevealAvailable();

  return (
    <section>
      <h1 className="text-xl font-bold">{t("backupsTitle")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("backupsHint")}</p>

      <div className="mt-4 grid gap-3 rounded border bg-card p-4">
        <div>
          <Button
            data-testid="backup-export"
            onClick={() => {
              reveal.reset();
              backup.mutate(undefined);
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
              onClick={() => reveal.mutate(backup.data.path)}
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
