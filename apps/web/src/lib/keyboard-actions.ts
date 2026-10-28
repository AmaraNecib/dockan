import type { MessageKey } from "./i18n";

export interface KeyboardShortcuts {
  onSale?: () => void;
  onPurchase?: () => void;
  onToggleSidebar?: () => void;
  onHelp?: () => void;
  onClose?: () => void;
}

type ShortcutAction = {
  id: keyof KeyboardShortcuts;
  key: string;
  keys: string;
  labelKey: MessageKey;
  scope: "navigation" | "shell" | "close";
  modifier: "ctrl" | "mod" | "none";
  shift?: boolean;
};

/** One registry for dispatch, help and hints. No inactive or future bindings. */
export const KEYBOARD_ACTIONS = [
  { id: "onSale", key: "n", keys: "Ctrl+N", labelKey: "shortcutSale", scope: "navigation", modifier: "ctrl" },
  { id: "onPurchase", key: "b", keys: "Ctrl+B", labelKey: "shortcutPurchase", scope: "navigation", modifier: "ctrl" },
  { id: "onToggleSidebar", key: "b", keys: "Ctrl/⌘+Shift+B", labelKey: "shortcutToggleSidebar", scope: "shell", modifier: "mod", shift: true },
  { id: "onHelp", key: "?", keys: "?", labelKey: "shortcutHelp", scope: "shell", modifier: "none" },
  { id: "onClose", key: "Escape", keys: "Esc", labelKey: "shortcutClose", scope: "close", modifier: "none" },
] as const satisfies readonly ShortcutAction[];

export function shortcutKeys(id: keyof KeyboardShortcuts): string {
  return KEYBOARD_ACTIONS.find((action) => action.id === id)?.keys ?? "";
}

export function matchKeyboardAction(event: KeyboardEvent) {
  return KEYBOARD_ACTIONS.find((action) => {
    if (event.altKey) return false;
    const keyMatches = event.key.toLowerCase() === action.key.toLowerCase() ||
      (action.modifier !== "none" && event.code === `Key${action.key.toUpperCase()}`);
    if (!keyMatches) return false;
    if (action.modifier === "none") {
      // '?' includes Shift on common layouts. Escape keeps its existing behavior.
      return !event.ctrlKey && !event.metaKey;
    }
    const shift = "shift" in action && action.shift;
    return event.shiftKey === Boolean(shift) &&
      (action.modifier === "ctrl" ? event.ctrlKey && !event.metaKey : event.ctrlKey || event.metaKey);
  });
}

/** Role dialogs include the catalog's custom modal and Base UI's portal. */
export function navigationDialogOpen(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'))
    .some((dialog) => !dialog.closest('[hidden], [aria-hidden="true"], [data-closed]'));
}
