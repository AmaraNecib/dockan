import { useEffect } from "react";

type InvoiceEntry = "sale" | "purchase";
const ENTRY_EVENT = "dokan:invoice-entry";

/** Focus existing entry without changing route search or resetting a draft. */
export function focusInvoiceEntry(kind: InvoiceEntry) {
  window.dispatchEvent(new CustomEvent(ENTRY_EVENT, { detail: kind }));
}

export function useInvoiceEntryShortcut(kind: InvoiceEntry, focus: () => void) {
  useEffect(() => {
    function onEntry(event: Event) {
      if (event instanceof CustomEvent && event.detail === kind) focus();
    }
    window.addEventListener(ENTRY_EVENT, onEntry);
    return () => window.removeEventListener(ENTRY_EVENT, onEntry);
  }, [kind, focus]);
}
