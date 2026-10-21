import { useEffect, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@/components/ui/dialog";

export interface DiscardDraftDialogProps {
  /** Whether the question is on screen. */
  open: boolean;
  /** The dialog closed without the destructive answer (Escape, backdrop). */
  onOpenChange: (open: boolean) => void;
  /** The owner answered «yes, throw the work away». */
  onConfirm: () => void;
  title: string;
  /** The body of the question; it says WHAT would be lost, not «unsaved changes». */
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  /** The test hook on the destructive answer. */
  confirmTestId?: string;
  /** The test hook on the answer that keeps the work. */
  cancelTestId?: string;
  /**
   * Where the caret goes when the dialog closes without a discard. The caller
   * owns that answer: it knows which control the owner was working in, and the
   * dialog only asks for the element (WCAG 2.4.3).
   */
  finalFocus?: ComponentProps<typeof DialogPopup>["finalFocus"];
}

/**
 * The shared question a screen asks before it throws away typed work (#321).
 *
 * The sale screen already had one, inside the shell's «New Sale» action; the
 * purchase screen needs the same question for a different trigger (a
 * navigation it is about to let through). The markup and the two answers live
 * here so the two screens cannot drift apart; the copy is the caller's,
 * because what would be lost is per screen.
 */
export function DiscardDraftDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmTestId,
  cancelTestId,
  finalFocus,
}: DiscardDraftDialogProps) {
  // #345 review round 4 (Greptile P2) — this question can open on top of another
  // dialog (the purchase screen's item picker), and that one owns focus, so an
  // Escape delivered to the focused element never reaches here and the owner has
  // to reach for the mouse. Answering Escape in the CAPTURE phase makes the
  // topmost question the one that answers it, whichever dialog holds the focus,
  // and leaves the dialog underneath open with its work intact.
  useEffect(() => {
    if (!open) return;
    const answerStay = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // this question is the top layer: the dialog beneath it must not consume
      // the key, and «stay» is the answer Escape means
      event.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener("keydown", answerStay, true);
    return () => document.removeEventListener("keydown", answerStay, true);
  }, [open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid={cancelTestId}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} data-testid={confirmTestId}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
