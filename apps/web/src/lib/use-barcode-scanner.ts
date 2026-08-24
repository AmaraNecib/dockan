import { useEffect, useRef } from "react";

/**
 * USB-wedge barcode capture (ticket 28). Wedge scanners "type" the code very
 * fast and finish with Enter.
 *
 * Two regimes:
 * - Focus outside any editable element: every printable keystroke belongs to
 *   the scan — there is nothing else those keys could be feeding. Enter
 *   commits. This is deterministic and load-independent.
 * - Focus inside an input/textarea: keys feed the field, so a scan is only
 *   recognized by burst timing (inter-key gaps under SCAN_MAX_GAP_MS); slower
 *   keying (a human, an IME composing Arabic) passes straight through and the
 *   buffer resets on any gap so a half-burst never leaks into the form.
 *
 * Duplicate protection: an identical commit within SCAN_DUPLICATE_WINDOW_MS
 * is dropped — some wedges send a code twice on a long press.
 */

/** max gap between keystrokes of one scan burst while focus is editable (ms) */
export const SCAN_MAX_GAP_MS = 50;
/** identical scans inside this window are ignored (ms) */
export const SCAN_DUPLICATE_WINDOW_MS = 800;
/** shortest buffer committed as a scan */
export const SCAN_MIN_LENGTH = 3;

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

export function useBarcodeScanner(onScan: (code: string) => void): void {
  // latest callback without re-binding the listener on every render
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let buffer = "";
    let lastKeyAt = 0;
    let lastCommitCode = "";
    let lastCommitAt = 0;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const now = performance.now();
      const editable = isEditableTarget(event.target);
      // in editable fields only a tight burst is a scan; elsewhere every
      // keystroke is scanner output, so gap timing must not drop it
      if (editable && now - lastKeyAt > SCAN_MAX_GAP_MS) buffer = "";
      lastKeyAt = now;

      if (event.key === "Enter") {
        const code = buffer;
        buffer = "";
        if (code.length < SCAN_MIN_LENGTH) return;
        // the scan's Enter must never submit whatever form has focus
        event.preventDefault();
        if (code === lastCommitCode && now - lastCommitAt < SCAN_DUPLICATE_WINDOW_MS) return;
        lastCommitCode = code;
        lastCommitAt = now;
        onScanRef.current(code);
        return;
      }

      if (event.key.length === 1) buffer += event.key;
    };

    const reset = () => {
      buffer = "";
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", reset);
    };
  }, []);
}
