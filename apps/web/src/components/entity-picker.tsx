import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

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
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
  const active = activeIndex === null ? undefined : matches[activeIndex];

  useEffect(() => {
    if (activeIndex !== null) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function pick(option: EntityOption) {
    onChange(option.id);
    setQuery(option.name);
    setOpen(false);
    setActiveIndex(null);
  }

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setQuery(selected?.name ?? "");
      setOpen(false);
      setActiveIndex(null);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open || matches.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => current === null ? (delta === 1 ? 0 : matches.length - 1) : (current + delta + matches.length) % matches.length);
      return;
    }
    if (event.key === "Enter" && open && active !== undefined) {
      event.preventDefault();
      pick(active);
    }
  }

  return (
    <div className="grid gap-1 text-sm font-medium" onBlur={(event) => {
      if (event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget)) return;
      setOpen(false);
      setQuery(selected?.name ?? "");
      setActiveIndex(null);
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
            setOpen(true);
            setActiveIndex(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={keyDown}
          data-testid={testId}
        />
        {open && (
          <div className="absolute z-30 mt-1 w-full rounded-lg border bg-popover text-foreground shadow-lg" data-testid={`${testId}-menu`}>
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
                    setOpen(false);
                    setQuery(selected?.name ?? "");
                    setActiveIndex(null);
                    onCreate?.(name);
                  }}
                  data-testid={`${testId}-create`}
                >
                  <Plus size={14} aria-hidden="true" />
                  {createLabel?.(trimmedQuery) ?? `Create ${trimmedQuery}`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
