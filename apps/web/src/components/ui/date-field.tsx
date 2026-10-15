import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { nowDateTimeText, parseDateTimeText } from "../../lib/dates";

/**
 * Issue #123 — the one day-first date/time control. A native
 * `<input type="datetime-local">` renders in the OS/browser locale (US
 * month/day, AM/PM on the owner's Windows build), so every editable moment is
 * this text field instead: `DD/MM/YYYY HH:mm`, Western digits, plus an «الآن»
 * button that stamps the device-local now.
 *
 * The text shape is already owned by `lib/dates.ts`; this component only asks
 * it whether the text is readable and never re-implements the parse. No `Date`
 * parsing and no `Intl` — the same text renders the same way on any machine.
 *
 * Two refusal modes, because the callers differ:
 * - a form that refuses at submit (the expense record) passes its own
 *   `invalid`/`errorId`, and the field points `aria-describedby` at that
 *   existing alert;
 * - a filter with no submit validates itself and renders its own alert, so a
 *   half-typed value is not scolded mid-keystroke. The refusal is derived from
 *   `value` (the parent owns it), and local state only *suppresses* it while a
 *   keystroke is in flight — so an unreadable value that the parent still holds
 *   still shows its warning after the field unmounts and remounts (a preset
 *   switch), instead of coming back clean.
 */
export interface DateFieldProps {
  id?: string;
  name?: string;
  /** controlled text in the app's shape: `DD/MM/YYYY HH:mm` */
  value: string;
  /** every edit as raw text, and the fresh now on an «الآن» click */
  onValueChange: (text: string) => void;
  testId: string;
  disabled?: boolean;
  /** a submit-time refusal the parent owns */
  invalid?: boolean;
  /** id of the alert carrying that refusal; it must be in the DOM whenever
   * `invalid` is true, because the field renders no node of its own then */
  errorId?: string;
  /** runs after «الآن» writes the value; use it to clear the *message* tied to
   * this field. The invalid flag itself is cleared by `onValueChange`. */
  onNow?: () => void;
}

export function DateField({
  id,
  name,
  value,
  onValueChange,
  testId,
  disabled = false,
  invalid,
  errorId,
  onNow,
}: DateFieldProps) {
  const { t } = useTranslation();
  // mid-edit only, never the source of the refusal: an unreadable value the
  // parent still holds derives its warning after any remount (mounting is not
  // editing), while a keystroke in flight does not scold the owner.
  const [editing, setEditing] = useState(false);

  // the empty field is "not provided", never unreadable; everything else has
  // to be a real day-first moment the moment it is parsed
  const unreadable = value.trim() !== "" && parseDateTimeText(value) === null;
  // an owned refusal (a submit) shows at once; the field's own shows whenever
  // the value is unreadable and no edit is in flight
  const refused = invalid === true || (errorId === undefined && !editing && unreadable);
  const nowTestId = `${testId}-now`;
  const ownErrorId = `${testId}-error`;
  const describedBy = errorId ?? ownErrorId;

  return (
    <div className="grid gap-1">
      <div className="flex gap-2">
        <input
          id={id}
          name={name}
          type="text"
          // min-w-0 lets the input shrink inside the flex row; its intrinsic
          // minimum would otherwise push the non-shrinking «الآن» button out
          className={cn(inputClass, "w-full min-w-0")}
          autoComplete="off"
          placeholder={t("expenseDateHint")}
          disabled={disabled}
          value={value}
          aria-invalid={refused || undefined}
          aria-describedby={refused ? describedBy : undefined}
          onChange={(event) => {
            onValueChange(event.target.value);
            // once the owner is editing again, stop scolding until they leave
            setEditing(true);
          }}
          onBlur={() => setEditing(false)}
          data-testid={testId}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          // a mousedown would move focus off the input, blurring it and flashing
          // a refusal for text «الآن» is about to replace; keep focus where it is
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onValueChange(nowDateTimeText());
            setEditing(false);
            onNow?.();
          }}
          data-testid={nowTestId}
        >
          {t("dateNow")}
        </Button>
      </div>
      {refused && errorId === undefined && (
        <p id={ownErrorId} role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid={ownErrorId}>
          {t("expenseDateInvalid")}
        </p>
      )}
    </div>
  );
}
