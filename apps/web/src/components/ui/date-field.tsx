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
 * - a filter with no submit validates itself and renders its own alert once
 *   the field has been left, so a half-typed value is not scolded mid-keystroke.
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
  const [blurred, setBlurred] = useState(false);

  // the empty field is "not provided", never unreadable; everything else has
  // to be a real day-first moment the moment it is parsed
  const unreadable = value.trim() !== "" && parseDateTimeText(value) === null;
  // an owned refusal (a submit) shows at once; the field's own waits for blur
  const refused = invalid === true || (errorId === undefined && blurred && unreadable);
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
          className={cn(inputClass, "w-full")}
          autoComplete="off"
          placeholder={t("expenseDateHint")}
          disabled={disabled}
          value={value}
          aria-invalid={refused || undefined}
          aria-describedby={refused ? describedBy : undefined}
          onChange={(event) => onValueChange(event.target.value)}
          onBlur={() => setBlurred(true)}
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
            setBlurred(false);
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
