"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Pencil, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  OBJECTIVE_TEMPLATES,
  type ObjectiveTemplate,
} from "@/lib/objective-templates";

type Group = { category: string; items: ObjectiveTemplate[] };

/**
 * Objective field: pick from a searchable library of win-back tactics, or write
 * a custom objective (the first option — preserves the original free-text input).
 */
export function ObjectivePicker({
  id,
  value,
  onChange,
  placeholder = "Search tactics or write your own…",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Focus the search box when the panel opens.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const trimmedQuery = query.trim();

  const groups = useMemo<Group[]>(() => {
    const q = trimmedQuery.toLowerCase();
    const map = new Map<string, ObjectiveTemplate[]>();
    for (const tpl of OBJECTIVE_TEMPLATES) {
      const match =
        q.length === 0 ||
        tpl.label.toLowerCase().includes(q) ||
        tpl.objective.toLowerCase().includes(q) ||
        tpl.category.toLowerCase().includes(q);
      if (!match) continue;
      const bucket = map.get(tpl.category) ?? [];
      bucket.push(tpl);
      map.set(tpl.category, bucket);
    }
    return Array.from(map, ([category, items]) => ({ category, items }));
  }, [trimmedQuery]);

  const commitCustom = () => {
    if (trimmedQuery.length === 0) {
      searchRef.current?.focus();
      return;
    }
    onChange(trimmedQuery);
    setQuery("");
    setOpen(false);
  };

  const commitTemplate = (tpl: ObjectiveTemplate) => {
    onChange(tpl.objective);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        id={id}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-1 text-left text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50",
        )}
      >
        <span
          className={cn(
            "line-clamp-1",
            value ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {value || placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 w-full origin-top overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
          {/* Search */}
          <div className="flex items-center gap-2 border-b border-border/60 px-2.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitCustom();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                }
              }}
              placeholder="Search 100 win-back tactics…"
              maxLength={300}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-72 overflow-y-auto p-1">
            {/* Custom — always the first option. */}
            <button
              type="button"
              onClick={commitCustom}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Pencil className="mt-0.5 size-4 shrink-0 text-copper" />
              <span className="flex flex-col">
                <span className="text-sm font-medium">Custom objective</span>
                <span className="line-clamp-1 text-xs text-muted-foreground">
                  {trimmedQuery
                    ? `Use “${trimmedQuery}”`
                    : "Write your own — type above"}
                </span>
              </span>
            </button>

            {groups.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                No tactics match “{trimmedQuery}”. Press Enter to use it as a
                custom objective.
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.category}>
                  <div className="px-2 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.category}
                  </div>
                  {group.items.map((tpl) => {
                    const selected = value === tpl.objective;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => commitTemplate(tpl)}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                          selected && "bg-accent/60",
                        )}
                      >
                        <span className="flex flex-1 flex-col">
                          <span className="text-sm">{tpl.label}</span>
                          <span className="line-clamp-1 text-xs text-muted-foreground">
                            {tpl.objective}
                          </span>
                        </span>
                        {selected && (
                          <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
