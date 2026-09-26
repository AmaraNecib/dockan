import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type SaleDraftValue = {
  /** True while the sale form holds unsaved input the user would lose on reset. */
  draftDirty: boolean;
  /** True while a sale-related mutation is in flight (save or quick-add). */
  savePending: boolean;
  setDraftDirty: (dirty: boolean) => void;
  setSavePending: (pending: boolean) => void;
};

const SaleDraftContext = createContext<SaleDraftValue | null>(null);

/**
 * Shares the sale form's "has unsaved input" / "save in flight" flags with the
 * header's New Sale action, so the action can refuse to reset a live form.
 */
export function SaleDraftProvider({ children }: { children: ReactNode }) {
  const [draftDirty, setDraftDirty] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const value = useMemo(
    () => ({ draftDirty, savePending, setDraftDirty, setSavePending }),
    [draftDirty, savePending],
  );
  return <SaleDraftContext.Provider value={value}>{children}</SaleDraftContext.Provider>;
}

export function useSaleDraft(): SaleDraftValue {
  const value = useContext(SaleDraftContext);
  if (value === null) {
    throw new Error("useSaleDraft must be used within SaleDraftProvider");
  }
  return value;
}
