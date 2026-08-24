import { useQuery } from "@tanstack/react-query";

import { orpc } from "../lib/rpc";

/**
 * Ticket 10 — invoice header. Prints the store identity (name + phone from
 * settings) at the top of an invoice display. Read-only and additive: any
 * future invoice view (sale checkout is ticket #30's PR) can mount it as-is.
 * The phone is stored in canonical +213 form; it is left-to-right text inside
 * the RTL layout, so it gets its own dir="ltr" span.
 */
export function InvoiceHeader() {
  const settings = useQuery(orpc.settingsGet.queryOptions());

  if (settings.isPending || !settings.data) return null;

  return (
    <header className="border-b border-stone-200 pb-2" data-testid="invoice-header">
      <p className="font-bold">{settings.data.storeName}</p>
      {settings.data.storePhone && (
        <p dir="ltr" className="text-sm text-stone-500">
          {settings.data.storePhone}
        </p>
      )}
    </header>
  );
}
