import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type SaleDraftValue = {
  /** True while the sale form holds unsaved input the user would lose on reset. */
  draftDirty: boolean;
  /** True while a sale-related mutation is in flight (save or quick-add). */
  savePending: boolean;
  draftDirtyRef: Readonly<{ current: boolean }>;
  savePendingRef: Readonly<{ current: boolean }>;
  claimOwner: (owner: symbol) => void;
  releaseOwner: (owner: symbol) => void;
  setDraftDirty: (owner: symbol, dirty: boolean) => void;
  setSavePending: (owner: symbol, pending: boolean) => void;
};

const SaleDraftContext = createContext<SaleDraftValue | null>(null);

/**
 * Shares the sale form's "has unsaved input" / "save in flight" flags with the
 * header's New Sale action, so the action can refuse to reset a live form.
 */
export function SaleDraftProvider({ children }: { children: ReactNode }) {
  const [draftDirty, setDraftDirtyState] = useState(false);
  const [savePending, setSavePendingState] = useState(false);
  const draftDirtyRef = useRef(false);
  const savePendingRef = useRef(false);
  const activeOwnerRef = useRef<symbol | null>(null);
  const setDraftDirty = useCallback((owner: symbol, dirty: boolean) => {
    if (activeOwnerRef.current !== owner) return;
    draftDirtyRef.current = dirty;
    setDraftDirtyState(dirty);
  }, []);
  const setSavePending = useCallback((owner: symbol, pending: boolean) => {
    if (activeOwnerRef.current !== owner) return;
    savePendingRef.current = pending;
    setSavePendingState(pending);
  }, []);
  const claimOwner = useCallback((owner: symbol) => {
    activeOwnerRef.current = owner;
    draftDirtyRef.current = false;
    savePendingRef.current = false;
    setDraftDirtyState(false);
    setSavePendingState(false);
  }, []);
  const releaseOwner = useCallback((owner: symbol) => {
    if (activeOwnerRef.current !== owner) return;
    activeOwnerRef.current = null;
    draftDirtyRef.current = false;
    savePendingRef.current = false;
    setDraftDirtyState(false);
    setSavePendingState(false);
  }, []);
  const value = useMemo(
    () => ({ draftDirty, savePending, draftDirtyRef, savePendingRef, claimOwner, releaseOwner, setDraftDirty, setSavePending }),
    [draftDirty, draftDirtyRef, savePending, savePendingRef, claimOwner, releaseOwner, setDraftDirty, setSavePending],
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
