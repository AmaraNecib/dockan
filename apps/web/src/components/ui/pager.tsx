import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";

import { PAGE_SIZE_PRESETS, clampOffset, isPageSize, pageCount, pageRange, pagerPages } from "../../lib/pagination";

export interface PagerProps {
  /** rows in the whole filtered list, not just this page */
  total: number;
  pageSize: number;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** test-id prefix so several pagers on one page stay addressable */
  testId?: string;
}

/**
 * The one pager every flat table shares (issue 163). Hidden while the whole
 * list fits one page, so a small shop never sees paging chrome it cannot use.
 * RTL: «السابق» leads on the right, page numbers read right-to-left, and the
 * counts use `tabular-nums` so the range does not jitter between pages.
 */
export function Pager({ total, pageSize, offset, onOffsetChange, onPageSizeChange, testId = "pager" }: PagerProps) {
  const { t } = useTranslation();
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState(String(pageSize));
  const [customInvalid, setCustomInvalid] = useState(false);

  // the list can shrink under the current page (a row deleted, a filter
  // narrowed elsewhere): snap back to the last real page instead of showing an
  // empty table. Runs before the hidden-at-one-page return so it still fires
  // when the list drops below a single page.
  useEffect(() => {
    const safe = clampOffset(offset, total, pageSize);
    if (safe !== offset) onOffsetChange(safe);
  }, [offset, total, pageSize, onOffsetChange]);

  if (total <= pageSize) return null;

  const pages = pageCount(total, pageSize);
  const current = Math.floor(offset / pageSize) + 1;
  const range = pageRange(offset, pageSize, total);
  const atFirst = offset <= 0;
  const atLast = current >= pages;

  function applyCustom(event: React.FormEvent) {
    event.preventDefault();
    // whole rows only; a typo must not silently request page 0 or 100 000
    const parsed = Number(customDraft.trim());
    // whole rows only, inside the server ceiling: a typo must not request
    // page 0 or a size the contract rejects
    if (!isPageSize(parsed)) {
      setCustomInvalid(true);
      return;
    }
    setCustomInvalid(false);
    setCustomOpen(false);
    onPageSizeChange(parsed);
  }

  const pageButtonClass = (active: boolean) =>
    cn(
      // Contain the absolute sr-only labels inside their buttons. Otherwise
      // labels below the scroll pane can enlarge the outer document.
      "relative min-w-8 rounded-lg border px-2 py-1 text-sm transition-colors tabular-nums",
      "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
      active ? "border-primary bg-primary text-primary-foreground" : "border-input hover:bg-muted",
    );

  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm"
      data-testid={testId}
    >
      <p className="text-muted-foreground tabular-nums" data-testid={`${testId}-range`}>
        {t("pagerRange", { from: range.from, to: range.to, total })}
      </p>

      <nav aria-label={t("pagerLabel")} className="flex items-center gap-1">
        <button
          type="button"
          className={cn(pageButtonClass(false), "disabled:pointer-events-none disabled:opacity-40")}
          disabled={atFirst}
          onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
          data-testid={`${testId}-prev`}
        >
          <ArrowRight size={16} aria-hidden="true" />
          <span className="sr-only">{t("pagerPrev")}</span>
        </button>
        {pagerPages(current, pages).map((entry, index) =>
          entry === "ellipsis" ? (
            <span key={`gap-${index}`} className="px-1 text-muted-foreground" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              className={pageButtonClass(entry === current)}
              aria-current={entry === current ? "page" : undefined}
              aria-label={t("pagerPage", { page: entry })}
              onClick={() => onOffsetChange((entry - 1) * pageSize)}
              data-testid={`${testId}-page-${entry}`}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          className={cn(pageButtonClass(false), "disabled:pointer-events-none disabled:opacity-40")}
          disabled={atLast}
          onClick={() => onOffsetChange(offset + pageSize)}
          data-testid={`${testId}-next`}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span className="sr-only">{t("pagerNext")}</span>
        </button>
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{t("pagerSize")}</span>
        <div role="group" aria-label={t("pagerSize")} className="flex items-center gap-1">
          {PAGE_SIZE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={pageButtonClass(pageSize === preset)}
              aria-pressed={pageSize === preset}
              onClick={() => onPageSizeChange(preset)}
              data-testid={`${testId}-size-${preset}`}
            >
              {preset}
            </button>
          ))}
          <button
            type="button"
            className={pageButtonClass(!PAGE_SIZE_PRESETS.some((preset) => preset === pageSize))}
            onClick={() => {
              setCustomDraft(String(pageSize));
              setCustomInvalid(false);
              setCustomOpen((open) => !open);
            }}
            data-testid={`${testId}-custom-toggle`}
          >
            {t("pagerCustom")}
          </button>
        </div>
        {customOpen && (
          <form className="flex items-center gap-1" onSubmit={applyCustom}>
            <input
              className={cn(inputClass, "w-20 px-2 py-1 text-sm tabular-nums")}
              inputMode="numeric"
              aria-label={t("pagerCustom")}
              aria-invalid={customInvalid || undefined}
              value={customDraft}
              onChange={(event) => {
                setCustomDraft(event.target.value);
                setCustomInvalid(false);
              }}
              data-testid={`${testId}-custom-input`}
            />
            <button
              type="submit"
              className="rounded-lg bg-primary px-2 py-1 text-sm text-primary-foreground transition-colors hover:bg-primary/80"
              data-testid={`${testId}-custom-apply`}
            >
              {t("pagerCustomApply")}
            </button>
            {customInvalid && (
              <span role="alert" className="text-xs text-destructive" data-testid={`${testId}-custom-invalid`}>
                {t("pagerCustomInvalid")}
              </span>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
