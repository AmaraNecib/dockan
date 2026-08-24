import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";

/**
 * Backups (ticket 13): one manual export button — a checkpoint+copy of the
 * shop's database the owner can move to a USB stick. The daily copy happens
 * automatically on api startup; this page only triggers the same seam by hand
 * and reports where the file landed.
 */
export function BackupsPage() {
  const { t } = useTranslation();
  const backup = useMutation(orpc.backupManual.mutationOptions());

  return (
    <section>
      <h1 className="text-xl font-bold">{t("backupsTitle")}</h1>
      <p className="mt-1 text-sm text-stone-600">{t("backupsHint")}</p>

      <div className="mt-4 grid gap-3 rounded border bg-white p-4">
        <div>
          <Button data-testid="backup-export" onClick={() => backup.mutate(undefined)} disabled={backup.isPending}>
            {backup.isPending ? t("backupsBusy") : t("backupsExport")}
          </Button>
        </div>
        {backup.isError && (
          <p className="text-sm text-red-600" role="alert">
            {tError(backup.error.message)}
          </p>
        )}
        {backup.isSuccess && (
          <div className="rounded bg-green-50 p-3 text-sm text-green-800" data-testid="backup-done">
            <p>{t("backupsDone")}</p>
            <p dir="ltr" className="mt-1 break-all font-mono text-xs">
              {backup.data.path}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
