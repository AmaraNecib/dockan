import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Popover } from "@base-ui/react/popover";

import { arabicIncludes } from "@dokan/contracts";
import { inputClass } from "@/components/ui/input";

export interface EntityOption {
  id: string;
  name: string;
}

interface EntityPickerProps {
  label: string;
  options: readonly EntityOption[];
  value: string;
  onChange: (value: string) => void;
  testId: string;
  disabled?: boolean;
  name?: string;
  onCreate?: (query: string) => void;
  createLabel?: (name: string) => string;
  noMatchesLabel?: string;
  hideLabel?: boolean;
  placeholder?: string;
}

/** Search and keyboard-select a growing entity list. Search text is not a selection. */
export function EntityPicker({
  label,
  options,
  value,
  onChange,
  testId,
  disabled = false,
  name,
  onCreate,
  createLabel,
  noMatchesLabel = "No matches",
  hideLabel = false,
  placeholder,
}: EntityPickerProps) {
  const selected = options.find((option) => option.id === value);
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = `${testId}-list`;
  const inputId = `${testId}-input`;

  useEffect(() => {
    if (!open) setQuery(selected?.name ?? "");
  }, [open, selected?.id, selected?.name]);

  const matches = useMemo(() => {
    const trimmed = query.trim();
    const filtered = trimmed === "" ? [...options] : options.filter((option) => arabicIncludes(option.name, trimmed));
    return filtered.slice(0, 50);
  }, [options, query]);
  const trimmedQuery = query.trim();
  const canCreate = onCreate !== undefined && trimmedQuery !== "" && matches.length === 0;
  const activeIndex = activeId === null ? null : matches.findIndex((option) => option.id === activeId);
  const active = activeIndex === null || activeIndex < 0 ? undefined : matches[activeIndex];

  useEffect(() => {
    if (activeIndex !== null && activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function openSearch() {
    setOpen(true);
  }

  function closeSearch() {
    setOpen(false);
    setQuery(selected?.name ?? "");
    setActiveId(null);
  }

  function pick(option: EntityOption) {
    onChange(option.id);
    setQuery(option.name);
    setOpen(false);
    setActiveId(null);
  }

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      closeSearch();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (matches.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        openSearch();
        setActiveId(matches[delta === 1 ? 0 : matches.length - 1]?.id ?? null);
        return;
      }
      const nextIndex = activeIndex === null || activeIndex < 0
        ? (delta === 1 ? 0 : matches.length - 1)
        : (activeIndex + delta + matches.length) % matches.length;
      setActiveId(matches[nextIndex]?.id ?? null);
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      if (active !== undefined) pick(active);
      else if (canCreate) {
        closeSearch();
        onCreate?.(trimmedQuery);
      }
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen) => nextOpen ? openSearch() : closeSearch()}>
      <div className="grid gap-1 text-sm font-medium" onBlur={(event) => {
      if (
        event.relatedTarget instanceof Node &&
        (event.currentTarget.contains(event.relatedTarget) || popupRef.current?.contains(event.relatedTarget))
      ) return;
      closeSearch();
    }}>
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : undefined}>{label}</label>
      <input type="hidden" name={name} value={value} />
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          className={inputClass}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active ? `${testId}-option-${active.id}` : undefined}
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            openSearch();
            setActiveId(null);
          }}
          onFocus={openSearch}
          onClick={openSearch}
          onKeyDown={keyDown}
          data-testid={testId}
        />
      </div>
      {open && (
        <Popover.Portal>
          <Popover.Positioner anchor={inputRef} side="bottom" align="start" sideOffset={4} className="z-50 w-[var(--anchor-width)]">
            <Popover.Popup ref={popupRef} initialFocus={false} finalFocus={false} className="rounded-lg border bg-popover text-foreground shadow-lg" data-testid={`${testId}-menu`}>
            <ul id={listId} role="listbox" aria-label={label} className="max-h-52 overflow-y-auto p-1">
              {matches.map((option, index) => (
                <li key={option.id} role="presentation">
                  <button
                    id={`${testId}-option-${option.id}`}
                    ref={(element) => { optionRefs.current[index] = element; }}
                    type="button"
                    role="option"
                    aria-selected={activeIndex === index}
                    tabIndex={-1}
                    className={`flex min-h-9 w-full items-center rounded px-2 py-1.5 text-start text-sm ${activeIndex === index ? "bg-accent" : "hover:bg-accent/60"}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(option)}
                    data-testid={`${testId}-option`}
                  >
                    {option.name}
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">{noMatchesLabel}</li>}
            </ul>
            {canCreate && (
              <div className="border-t p-1">
                <button
                  type="button"
                  className="flex min-h-9 w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm font-medium text-primary hover:bg-accent"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const name = trimmedQuery;
                    closeSearch();
                    onCreate?.(name);
                  }}
                  data-testid={`${testId}-create`}
                >
                  <Plus size={14} aria-hidden="true" />
                  {createLabel?.(trimmedQuery) ?? `Create ${trimmedQuery}`}
                </button>
              </div>
            )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      )}
      </div>
    </Popover.Root>
  );
}
