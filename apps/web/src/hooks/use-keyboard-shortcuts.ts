import { useCallback, useEffect } from "react";
import { matchKeyboardAction, navigationDialogOpen, type KeyboardShortcuts } from "@/lib/keyboard-actions";

export type { KeyboardShortcuts } from "@/lib/keyboard-actions";

/** Ctrl-letter actions work in fields; unmodified help never replaces typing. */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcuts) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const action = matchKeyboardAction(event);
      if (!action || !shortcuts[action.id]) return;
      const el = event.target;
      const isInput = el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ||
          el.isContentEditable || el.closest('[contenteditable="true"]') !== null);
      if (isInput && action.modifier === "none") {
        // Preserve Escape from fields, including its previous default handling.
        if (action.id === "onClose") shortcuts.onClose?.();
        return;
      }
      event.preventDefault();
      if (event.repeat) return;
      if (action.scope === "navigation" && navigationDialogOpen()) return;
      shortcuts[action.id]?.();
    },
    [shortcuts],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
