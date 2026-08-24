import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * Minimal modal-dialog behavior shared by the catalog dialogs (ticket 28):
 * Escape closes, focus moves to the first focusable element on open, Tab is
 * trapped inside the dialog, and focus returns to the previously focused
 * element on close. Pairs with role="dialog" + aria-modal on the panel.
 */
export function useModalDialog<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const panelRef = useRef<T>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    // SAFETY: activeElement is an HTMLElement in any real browser context
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // move focus into the dialog once it has painted
    const raf = requestAnimationFrame(() => {
      const first = panel?.querySelector<HTMLElement>("input, button, select, textarea, [tabindex]:not([tabindex='-1'])");
      first?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab" && panel !== null) {
        // cycle focus within the dialog
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>("input, button, select, textarea, [tabindex]:not([tabindex='-1'])"),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const active = document.activeElement;
        // SAFETY: activeElement is one of the focusables we just focused, or null
        const currentIndex = focusables.indexOf(active as HTMLElement);
        // double modulo wraps negatives (shift-tab from the first element)
        const nextIndex = ((event.shiftKey ? currentIndex - 1 : currentIndex + 1) % focusables.length + focusables.length) % focusables.length;
        const next = focusables[nextIndex];
        if (next !== undefined) {
          event.preventDefault();
          next.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [open, onClose, t]);

  return {
    panelRef,
    closeLabel: t("dialogClose"),
  };
}
