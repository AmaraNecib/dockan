import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useModalDialog } from "@/lib/use-modal-dialog";

/**
 * Unknown-scan dialog (ticket 28): a scanned code matched nothing, and
 * nothing is created silently — the owner picks one of four explicit paths.
 * Manual-line is honest about being deferred to the invoice flow (#30).
 */
export function UnknownScanDialog({
  code,
  onCreate,
  onCreateWithStock,
  onManualLine,
  onClose,
}: {
  code: string;
  /** prefill the item form with this barcode */
  onCreate: () => void;
  /** same, plus the initial-stock field */
  onCreateWithStock: () => void;
  onManualLine: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { panelRef } = useModalDialog<HTMLDivElement>(true, onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="unknown-scan-dialog" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("scanUnknownTitle")} className="w-full max-w-md rounded-2xl border bg-popover p-5 shadow-lg">
        <h2 className="text-lg font-bold">{t("scanUnknownTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("scanUnknownCode")}:{" "}
          <span dir="ltr" className="font-mono">
            {code}
          </span>
        </p>
        <div className="mt-4 grid gap-2">
          <Button data-testid="scan-create" onClick={onCreate}>
            {t("scanCreateItem")}
          </Button>
          <Button variant="outline" data-testid="scan-create-stock" onClick={onCreateWithStock}>
            {t("scanCreateWithStock")}
          </Button>
          <Button variant="outline" data-testid="scan-manual-line" onClick={onManualLine}>
            {t("scanManualLine")}
          </Button>
          <Button variant="ghost" data-testid="scan-cancel" onClick={onClose}>
            {t("scanCancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
