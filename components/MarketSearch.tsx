"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface Suggestion {
  label: string;
  value: string;
  sub: string;
  slug: string;
  kind: string;
}

interface Props {
  scope: "events" | "fixtures";
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  onSelect: (s: Suggestion) => void;
  hint?: string;
  flex?: number;
  autoFocus?: boolean;
}

/**
 * Accessible typeahead over REAL live Polymarket markets (/api/search). Combobox pattern:
 * arrow keys move the active option, Enter selects, Escape closes; aria-activedescendant
 * tracks the highlighted row. Degrades to a plain text input if search returns nothing.
 */
export default function MarketSearch({
  scope,
  label,
  placeholder,
  value,
  onChange,
  onSelect,
  hint,
  flex,
  autoFocus,
}: Props) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const skipFetch = useRef(false); // suppress the fetch that a programmatic select would trigger
  const baseId = useId();
  const listId = `${baseId}-list`;

  // Debounced search against the live endpoint when the user types (≥2 chars, focused).
  useEffect(() => {
    if (skipFetch.current) {
      skipFetch.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      try {
        const r = await fetch(`/api/search?scope=${scope}&q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data: { suggestions?: Suggestion[] } = await r.json();
        setItems(data.suggestions ?? []);
        setActive(-1);
      } catch {
        /* aborted or offline — leave the last results */
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [value, scope]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const choose = useCallback(
    (s: Suggestion) => {
      skipFetch.current = true;
      onChange(s.value);
      onSelect(s);
      setOpen(false);
      setItems([]);
      setActive(-1);
    },
    [onChange, onSelect],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => Math.min((items.length || 0) - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        choose(items[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showPop = open && value.trim().length >= 2; // pop renders loading / empty / results inside

  return (
    <label className="combo-label" style={flex ? { flex } : undefined}>
      {label}
      <div className="combo" ref={wrap}>
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={showPop}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${baseId}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => value.trim().length >= 2 && setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {showPop && (
          <div className="combo-pop" role="listbox" id={listId}>
            {loading && items.length === 0 && <div className="combo-msg">Searching live markets…</div>}
            {!loading && items.length === 0 && (
              <div className="combo-msg">No live market matches “{value.trim()}”. Only real Polymarket markets show here.</div>
            )}
            {items.map((s, i) => (
              <div
                key={`${s.slug}-${s.value}-${i}`}
                id={`${baseId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`combo-opt${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus; fire select before blur
                  choose(s);
                }}
              >
                <span className="combo-opt-label">{s.label}</span>
                <span className="combo-opt-sub">{s.sub}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {hint && <span className="combo-hint">{hint}</span>}
    </label>
  );
}
