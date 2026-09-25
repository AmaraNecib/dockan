import { useCallback, useEffect } from "react";

export interface KeyboardShortcuts {
  /** Cmd/Ctrl+Shift+B: toggle the sidebar. */
  onToggleSidebar?: () => void;
  /** `?`: open the keyboard shortcuts help. */
  onHelp?: () => void;
  /** Escape: close the topmost open dialog. */
  onClose?: () => void;
}

/**
 * Global keyboard-shortcut hook. Modeled on the proven tuari_react_hono hook:
 * a small hand-rolled keydown listener (no dependency) that skips firing while
 * the user is typing in an input, so shortcut keys never swallow real input.
 * Shortcut bindings deliberately avoid browser-reserved chords (plain Cmd+B
 * opens the bookmarks bar; plain Cmd+N opens a new window).
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcuts) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // SAFETY: keydown targets are Element or Window in the DOM; the cast
      // only narrows to HTMLElement so the is-input check can read tagName.
      const el = event.target as HTMLElement | null;
      const isInput =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);

      if (isInput) {
        // Escape still works while a field is focused (closes dialogs/back).
        if (event.key === "Escape") shortcuts.onClose?.();
        return;
      }

      const isMod = event.metaKey || event.ctrlKey;
      const isShift = event.shiftKey;

      // Cmd/Ctrl+Shift+B — toggle sidebar.
      if (isMod && isShift && event.key.toLowerCase() === "b") {
        event.preventDefault();
        shortcuts.onToggleSidebar?.();
        return;
      }

      // ? — open shortcuts help.
      if (event.key === "?") {
        event.preventDefault();
        shortcuts.onHelp?.();
        return;
      }

      // Escape — close.
      if (event.key === "Escape") {
        event.preventDefault();
        shortcuts.onClose?.();
        return;
      }
    },
    [shortcuts],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}