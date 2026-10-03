import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { displayAlgerianPhone } from "@dokan/contracts";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";

/**
 * Ticket 10 — invoice header. Prints the store identity (name + phone from
 * settings) at the top of an invoice display. Read-only and additive: any
 * future invoice view (sale checkout is ticket #30's PR) can mount it as-is.
 * Three states, never a silent blank: a skeleton while the settings load, an
 * alert + retry when the read fails, and the identity itself when it lands.
 * The phone is stored in canonical +213 form and displayed in the owner's local
 * 0-prefixed form; it is left-to-right text inside the RTL layout, so it gets
 * its own dir="ltr" span.
 */
export function InvoiceHeader() {
  const { t } = useTranslation();
  const settings = useQuery(orpc.settingsGet.queryOptions());

  return (
    <header className="border-b border-border pb-2" data-testid="invoice-header">
      {settings.isPending ? (
        <Skeleton className="h-5 w-40" data-testid="invoice-header-loading" />
      ) : settings.isError ? (
        <div role="alert" className="flex items-center justify-between gap-2" data-testid="invoice-header-error">
          <span className="text-sm text-destructive">{t("activityError")}</span>
          <button
            type="button"
            className="text-sm underline"
            onClick={() => void settings.refetch()}
            data-testid="invoice-header-retry"
          >
            {t("itemsSearchRetry")}
          </button>
        </div>
      ) : (
        <>
          <p className="font-bold">{settings.data.storeName}</p>
          {settings.data.storePhone !== null && settings.data.storePhone !== "" && (
            <p dir="ltr" className="text-sm text-muted-foreground">
              {displayAlgerianPhone(settings.data.storePhone)}
            </p>
          )}
        </>
      )}
    </header>
  );
}