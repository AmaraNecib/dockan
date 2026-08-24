import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { CatalogMatch, Item } from "@dokan/contracts";

import { orpc } from "@/lib/rpc";
import { useModalDialog } from "@/lib/use-modal-dialog";

/** LTR-isolated barcode text inside the RTL layout */
function Barcode({ code }: { code: string }) {
  return (
    <span dir="ltr" className="font-mono text-xs text-stone-500">
      {code}
    </span>
  );
}

export function matchBadgeKey(matchedBy: CatalogMatch["matchedBy"]): string {
  return `matchedBy${matchedBy.charAt(0)}${matchedBy.slice(1).toLowerCase()}`;
}

/**
 * Manual catalog picker (ticket 28) — same search behavior as scanning:
 * debounced catalogSearch, ranked matches, keyboard + RTL friendly.
 */
export function ItemPickerDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (item: Item) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const { panelRef } = useModalDialog<HTMLDivElement>(open, onClose);

  // debounce search keystrokes so typing stays snappy
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // focus + reset each time the dialog opens
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebounced("");
      setActiveIndex(null);
      optionRefs.current = [];
      // let the dialog paint before stealing focus
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const search = useQuery({
    ...orpc.catalogSearch.queryOptions({ input: { query: debounced || " " }, enabled: open && debounced.length > 0 }),
  });
  const matches = search.data?.matches ?? [];
  const visibleActiveIndex = activeIndex !== null && activeIndex < matches.length ? activeIndex : null;
  const matchSetKey = matches.map((match) => match.item.id).join("|");

  // A refetch can replace the ranked set without a query input event. Do not
  // leave an index pointing at a different item after that result change.
  useEffect(() => {
    setActiveIndex(null);
  }, [matchSetKey]);

  useEffect(() => {
    if (visibleActiveIndex === null) return;
    // The list can be shorter after a new result arrives; optional chaining keeps
    // this safe in non-layout test DOMs as well as real browsers.
    optionRefs.current[visibleActiveIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [visibleActiveIndex]);

  if (!open) return null;

  function handleBackdrop(event: React.MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/30 pt-24"
      data-testid="picker-dialog"
      onMouseDown={handleBackdrop}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("itemsSearchPlaceholder")}
        className="w-full max-w-lg rounded-2xl border bg-white p-4 shadow-lg"
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-label={t("itemsSearchPlaceholder")}
          aria-autocomplete="list"
          aria-controls="picker-results"
          aria-expanded={debounced.length > 0}
          aria-activedescendant={visibleActiveIndex !== null ? `picker-option-${matches[visibleActiveIndex]!.item.id}` : undefined}
          className="w-full rounded border px-3 py-2"
          placeholder={t("itemsSearchPlaceholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onClose();
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (matches.length === 0) return;
              e.preventDefault();
              const direction = e.key === "ArrowDown" ? 1 : -1;
              setActiveIndex((current) => {
                if (current === null || current >= matches.length) return direction === 1 ? 0 : matches.length - 1;
                return (current + direction + matches.length) % matches.length;
              });
              return;
            }
            if (e.key === "Enter") {
              const selected = matches[visibleActiveIndex ?? 0];
              if (selected) {
                e.preventDefault();
                onSelect(selected.item);
              }
            }
          }}
        />
        {debounced.length > 0 && search.data?.exact && (
          <button
            type="button"
            className="mt-2 w-full rounded border bg-stone-50 p-2 text-right hover:bg-stone-100"
            onClick={() => onSelect(search.data!.exact!.item)}
          >
            {search.data.exact.item.name} <Barcode code={search.data.exact.item.barcode ?? ""} />
          </button>
        )}
        <ul id="picker-results" role="listbox" aria-label={t("itemsSearchPlaceholder")} className="mt-2 max-h-80 overflow-y-auto">
          {matches.map((match: CatalogMatch, index) => {
            const isActive = visibleActiveIndex === index;
            const optionId = `picker-option-${match.item.id}`;
            return (
              <li
                key={match.item.id}
                id={optionId}
                role="option"
                aria-selected={isActive}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
              >
                <button
                  type="button"
                  className={`flex w-full items-center justify-between rounded p-2 text-right ${isActive ? "bg-stone-200 ring-2 ring-inset ring-stone-500" : "hover:bg-stone-100"}`}
                  onClick={() => onSelect(match.item)}
                >
                  <span>{match.item.name}</span>
                  <span className="flex items-center gap-2">
                    {match.item.barcode && <Barcode code={match.item.barcode} />}
                    <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600">{t(matchBadgeKey(match.matchedBy))}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {debounced.length > 0 && !search.isPending && matches.length === 0 && !search.data?.exact && (
          <p className="mt-2 text-sm text-stone-500">{t("itemsSearchEmpty")}</p>
        )}
      </div>
    </div>
  );
}
