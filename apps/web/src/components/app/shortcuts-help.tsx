import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  const { t } = useTranslation();

  const rows: { keys: string; labelKey: string }[] = [
    { keys: "Ctrl/⌘ + K", labelKey: "shortcutSearch" },
    { keys: "Ctrl/⌘+Shift+B", labelKey: "shortcutToggleSidebar" },
    { keys: "?", labelKey: "shortcutHelp" },
    { keys: "Esc", labelKey: "shortcutClose" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("shortcutsTitle")}</DialogTitle>
          <DialogDescription>{t("shortcutsHint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.keys} className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{t(row.labelKey)}</span>
              <kbd className="rounded border bg-muted px-2 py-0.5 font-mono text-xs whitespace-nowrap" dir="ltr">
                {row.keys}
              </kbd>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("dialogClose")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}