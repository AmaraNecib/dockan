import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { saleOverrideInvalid, saleUnitPrice, type SaleDraftLine } from "@/lib/invoice-draft";
import { salePriceInput, switchSalePriceMode, type SalePriceMode, type SalePriceOverride } from "@/lib/sale-price-editor";
import { cn } from "@/lib/utils";

export function SaleLinePriceEditor({ line, preferredMode, onMode, onChange, disabled }: {
  line: SaleDraftLine;
  preferredMode: SalePriceMode;
  onMode: (mode: SalePriceMode) => void;
  onChange: (override: SalePriceOverride) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [chosenMode, setChosenMode] = useState<SalePriceMode | null>(null);
  const [switchError, setSwitchError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const amountRadio = useRef<HTMLInputElement>(null);
  const percentageRadio = useRef<HTMLInputElement>(null);
  const previousPercentage = useRef<string | undefined>(undefined);
  const modeGroupId = useId();
  const meaningId = useId();
  const errorId = useId();
  const mode = chosenMode ?? (line.overrideType || preferredMode);
  const invalid = saleOverrideInvalid(line);

  function reset() {
    onChange({ overrideType: "", overrideValue: "" });
    setSwitchError(false);
    previousPercentage.current = undefined;
  }

  function selectMode(value: string | null) {
    if (value !== "AMOUNT" && value !== "PERCENTAGE") return;
    if (value === mode) return;
    const override = switchSalePriceMode(line, value, previousPercentage.current);
    if (override === null) {
      setSwitchError(true);
      (mode === "AMOUNT" ? amountRadio : percentageRadio).current?.focus();
      return;
    }
    if (line.overrideType === "PERCENTAGE") previousPercentage.current = line.overrideValue;
    onChange(override);
    setChosenMode(value);
    setSwitchError(false);
    onMode(value);
  }

  return <div className="grid min-w-64 gap-1">
    <div className="flex flex-wrap items-center gap-2">
      <input ref={input} className={cn(inputClass, "w-28 px-2 py-1")} autoComplete="off" inputMode="numeric" dir="ltr"
        value={salePriceInput(line, mode)} aria-label={`${line.item.name}: ${t("saleOverrideValue")}`}
        aria-invalid={invalid || undefined} aria-describedby={`${meaningId}${switchError ? ` ${errorId}` : ""}`}
        onChange={(event) => { setChosenMode(mode); setSwitchError(false); onChange({ overrideType: mode, overrideValue: event.target.value }); }} disabled={disabled} />
      <div role="radiogroup" aria-label={`${line.item.name}: ${t("saleOverrideType")}`} data-testid="sale-price-mode" className="inline-flex overflow-hidden rounded-md border border-input">
        <label className="relative cursor-pointer">
          <input ref={amountRadio} type="radio" name={modeGroupId} value="AMOUNT" aria-label={`${line.item.name}: ${t("saleOverrideDzd")}`} checked={mode === "AMOUNT"} onChange={() => selectMode("AMOUNT")} disabled={disabled} className="peer sr-only" />
          <span className="block px-2 py-1 text-xs text-muted-foreground peer-checked:bg-accent peer-checked:text-accent-foreground peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-ring">دج</span>
        </label>
        <label className="relative cursor-pointer border-s border-input">
          <input ref={percentageRadio} type="radio" name={modeGroupId} value="PERCENTAGE" aria-label={`${line.item.name}: ${t("saleOverridePercentAccessible")}`} checked={mode === "PERCENTAGE"} onChange={() => selectMode("PERCENTAGE")} disabled={disabled} className="peer sr-only" />
          <span className="block px-2 py-1 text-xs text-muted-foreground peer-checked:bg-accent peer-checked:text-accent-foreground peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-ring">%</span>
        </label>
      </div>
    </div>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{t("salePriceDefault")} <Amount value={line.item.sellingPrice} /></span>
      <Button type="button" variant="ghost" size="sm" data-testid="sale-price-reset" onClick={reset} disabled={disabled}>{t("saleResetPrice")}</Button>
    </div>
    <span id={meaningId} data-testid="sale-price-meaning" className="text-xs text-muted-foreground">
      {mode === "PERCENTAGE" ? t("salePriceShare") : t("salePricePerUnit")} {invalid ? t("salePriceUnusable") : <Amount value={saleUnitPrice(line)} />}
    </span>
    {switchError && <span id={errorId} role="alert" className="text-xs text-destructive">{t("salePriceSwitchRefused")}</span>}
  </div>;
}
