import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Amount } from "@/components/ui/amount";
import { inputClass } from "@/components/ui/input";
import {
  amountFromPercentage,
  parseGroupedAmount,
  parseLooseNumber,
  parseWholeAmount,
  parseWholePercentage,
  percentageDraftInvalid,
  percentageFromAmount,
} from "@/lib/amount-parse";
import { cn } from "@/lib/utils";

// #180 — the low-level readers live in @/lib/amount-parse so every money input
// shares one grouped-amount parser. Re-exported here so existing importers keep
// their import site; new money fields import from the lib directly.
export {
  amountFromPercentage,
  parseGroupedAmount,
  parseLooseNumber,
  parseWholeAmount,
  parseWholePercentage,
  percentageDraftInvalid,
  percentageFromAmount,
};

/**
 * #162 — the shared amount-or-percentage input (CONTEXT.md: مبلغ أو نسبة).
 *
 * Wherever an amount is a share of a known reference (an invoice's remaining, a
 * return value, a cart total) the owner types either the amount or a percentage
 * of that reference and the other side follows. The reference total is rendered
 * next to the fields so «50%» is unambiguous. When there is no reference there
 * is nothing to take a percentage of, so only the amount field is rendered.
 *
 * The pair is CONTROLLED: the consumer seeds `value` (normally the full
 * reference / 100) and receives every linked update through `onChange`. The
 * component never invents a value, so an empty draft stays empty.
 */
export interface AmountPercentageValue {
  amount: string;
  percentage: string;
}

/** The link when the owner edits the amount: percentage follows. */
export function amountEdited(referenceTotal: number | null | undefined, amountDraft: string): AmountPercentageValue {
  if (!hasReference(referenceTotal)) return { amount: amountDraft, percentage: "" };
  const parsed = parseGroupedAmount(amountDraft);
  return { amount: amountDraft, percentage: parsed === null ? "" : String(percentageFromAmount(referenceTotal, parsed)) };
}

/** The link when the owner edits the percentage: amount follows, 100-capped. */
export function percentageEdited(referenceTotal: number | null | undefined, percentageDraft: string): AmountPercentageValue {
  if (!hasReference(referenceTotal)) return { amount: "", percentage: "" };
  const parsed = parseWholePercentage(percentageDraft);
  if (parsed !== null) {
    return { amount: String(amountFromPercentage(referenceTotal, parsed)), percentage: percentageDraft };
  }
  // a percentage above 100 is the one draft the component clamps rather than
  // rejecting: the cap keeps the amount from ever exceeding the reference. The
  // fallback reads through the normalizer so `«١٥٠»` clamps like `"150"`.
  const numeric = parseLooseNumber(percentageDraft);
  if (percentageDraft.trim() !== "" && Number.isFinite(numeric) && numeric > 100) {
    return { amount: String(referenceTotal), percentage: "100" };
  }
  return { amount: "", percentage: percentageDraft };
}

/** True when a reference total exists and can be a percentage base. */
export function hasReference(referenceTotal: number | null | undefined): referenceTotal is number {
  return referenceTotal != null && Number.isFinite(referenceTotal) && referenceTotal > 0;
}

export interface AmountPercentageInputProps {
  /** the share base. null/absent → the percentage field is not rendered. */
  referenceTotal?: number | null;
  value: AmountPercentageValue;
  /** the linked pair, plus which field the owner just edited (the source of truth) */
  onChange: (next: AmountPercentageValue, edited: "amount" | "percentage") => void;
  amountLabel: string;
  percentageLabel?: string;
  referenceLabel?: string;
  amountTestId?: string;
  percentageTestId?: string;
  referenceTestId?: string;
  amountPlaceholder?: string;
  disabled?: boolean;
  /** the amount field's own invalidity (e.g. over the remaining) */
  amountInvalid?: boolean;
  /** the percentage field's own invalidity (a non-empty non-whole-percent draft) */
  percentageInvalid?: boolean;
}

export function AmountPercentageInput({
  referenceTotal,
  value,
  onChange,
  amountLabel,
  percentageLabel,
  referenceLabel,
  amountTestId = "amount-percentage-amount",
  percentageTestId = "amount-percentage-percentage",
  referenceTestId = "amount-percentage-reference",
  amountPlaceholder,
  disabled = false,
  amountInvalid = false,
  percentageInvalid = false,
}: AmountPercentageInputProps) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const showPercentage = hasReference(referenceTotal);
  const referenceId = `${idPrefix}-reference`;

  return (
    <div className="grid gap-2" data-testid="amount-percentage-input">
      <div className={cn("grid gap-3", showPercentage ? "grid-cols-2" : "grid-cols-1")}>
        <label className="grid gap-1 text-sm" htmlFor={`${idPrefix}-amount`}>
          {amountLabel}
          <input
            id={`${idPrefix}-amount`}
            className={inputClass}
            inputMode="numeric"
            aria-invalid={amountInvalid || undefined}
            aria-describedby={showPercentage ? referenceId : undefined}
            value={value.amount}
            placeholder={amountPlaceholder}
            disabled={disabled}
            onChange={(event) => onChange(amountEdited(referenceTotal, event.target.value), "amount")}
            data-testid={amountTestId}
          />
        </label>
        {showPercentage && (
          <label className="grid gap-1 text-sm" htmlFor={`${idPrefix}-percentage`}>
            {percentageLabel ?? t("amountPercentageLabel")}
            <input
              id={`${idPrefix}-percentage`}
              className={inputClass}
              inputMode="numeric"
              aria-invalid={percentageInvalid || undefined}
              aria-describedby={referenceId}
              value={value.percentage}
              disabled={disabled}
              onChange={(event) => onChange(percentageEdited(referenceTotal, event.target.value), "percentage")}
              data-testid={percentageTestId}
            />
          </label>
        )}
      </div>
      {showPercentage && (
        <p id={referenceId} className="text-xs text-muted-foreground" data-testid={referenceTestId}>
          {referenceLabel ?? t("amountReferenceLabel")}: <Amount value={referenceTotal} />
        </p>
      )}
    </div>
  );
}
