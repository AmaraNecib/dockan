import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { CatalogMatch, Item } from "@dokan/contracts";

import { orpc } from "@/lib/rpc";

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
  const inputRef = useRef<HTMLInputElement>(null);

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
      // let the dialog paint before stealing focus
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const search = useQuery({
    ...orpc.catalogSearch.queryOptions({ input: { query: debounced || " " }, enabled: open && debounced.length > 0 }),
  });

  if (!open) return null;

  const matches = search.data?.matches ?? [];

  function handleBackdrop(event: React.MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/30 pt-24"
      data-testid="picker-dialog"
      onMouseDown={handleBackdrop}
    >
      <div role="dialog" aria-modal="true" aria-label={t("itemsSearchPlaceholder")} className="w-full max-w-lg rounded-2xl border bg-white p-4 shadow-lg">
        <input
          ref={inputRef}
          className="w-full rounded border px-3 py-2"
          placeholder={t("itemsSearchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && matches[0]) {
              e.preventDefault();
              onSelect(matches[0].item);
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
        <ul className="mt-2 max-h-80 overflow-y-auto">
          {matches.map((match: CatalogMatch) => (
            <li key={match.item.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded p-2 text-right hover:bg-stone-100"
                onClick={() => onSelect(match.item)}
              >
                <span>{match.item.name}</span>
                <span className="flex items-center gap-2">
                  {match.item.barcode && <Barcode code={match.item.barcode} />}
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600">{t(matchBadgeKey(match.matchedBy))}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {debounced.length > 0 && !search.isPending && matches.length === 0 && !search.data?.exact && (
          <p className="mt-2 text-sm text-stone-500">{t("itemsSearchEmpty")}</p>
        )}
      </div>
    </div>
  );
}
