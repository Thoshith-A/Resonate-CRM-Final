"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Sparkles, Trash2, Users } from "lucide-react";
import {
  COMPARATOR_LABELS,
  MAX_SEGMENT_DEPTH,
  SEGMENT_FIELD_DEFS,
  SegmentRulesSchema,
  type SegmentComparator,
  type SegmentField,
  type SegmentRules,
} from "@resonate/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatNumber, formatRupees } from "@/lib/format";
import { describeRules } from "@/lib/segment-describe";
import type { SegmentPreview } from "@/server/segments/previewSegment";
import type { AiSegmentResult } from "@/server/ai/segmentFromText";

const CITY_SUGGESTIONS = [
  "Mumbai", "Delhi", "Bangalore", "Pune", "Hyderabad",
  "Chennai", "Kolkata", "Ahmedabad", "Jaipur", "Surat", "Lucknow",
];
const TAG_SUGGESTIONS = ["subscriber", "gifted", "wholesale"];

// ── Builder tree (transient ids for React keys; AST has none) ─────────────
type BuilderValue = number | string | string[];
type BuilderCondition = {
  id: string;
  kind: "condition";
  field: SegmentField;
  cmp: SegmentComparator;
  value: BuilderValue;
};
type BuilderGroup = {
  id: string;
  kind: "group";
  op: "AND" | "OR";
  children: BuilderNode[];
};
type BuilderNode = BuilderCondition | BuilderGroup;

function newId(): string {
  return Math.random().toString(36).slice(2);
}

function fieldDef(field: SegmentField) {
  const def = SEGMENT_FIELD_DEFS.find((d) => d.field === field);
  if (!def) {
    throw new Error(`Unknown field ${field}`);
  }
  return def;
}

function defaultValueFor(field: SegmentField, cmp: SegmentComparator): BuilderValue {
  const kind = fieldDef(field).kind;
  if (kind === "city") {
    return cmp === "in" ? [] : "";
  }
  if (kind === "tags") {
    return "";
  }
  return 0;
}

function newCondition(): BuilderCondition {
  return { id: newId(), kind: "condition", field: "total_spend", cmp: "gt", value: 0 };
}

function newGroup(op: "AND" | "OR" = "AND"): BuilderGroup {
  return { id: newId(), kind: "group", op, children: [newCondition()] };
}

function toRules(node: BuilderNode): SegmentRules {
  if (node.kind === "condition") {
    return { field: node.field, cmp: node.cmp, value: node.value } as SegmentRules;
  }
  return { op: node.op, children: node.children.map(toRules) } as SegmentRules;
}

function fromRules(rules: SegmentRules): BuilderNode {
  if ("op" in rules) {
    return { id: newId(), kind: "group", op: rules.op, children: rules.children.map(fromRules) };
  }
  return { id: newId(), kind: "condition", field: rules.field, cmp: rules.cmp, value: rules.value };
}

// Immutable tree transforms keyed by node id.
function transform(node: BuilderNode, id: string, fn: (n: BuilderNode) => BuilderNode): BuilderNode {
  if (node.id === id) {
    return fn(node);
  }
  if (node.kind === "group") {
    return { ...node, children: node.children.map((child) => transform(child, id, fn)) };
  }
  return node;
}

function removeFrom(node: BuilderGroup, id: string): BuilderGroup {
  return {
    ...node,
    children: node.children
      .filter((child) => child.id !== id)
      .map((child) => (child.kind === "group" ? removeFrom(child, id) : child)),
  };
}

export function SegmentBuilder({
  initialRules,
  initialName,
  onSaved,
}: {
  initialRules?: SegmentRules;
  initialName?: string;
  onSaved?: (id: string) => void;
}) {
  const [root, setRoot] = useState<BuilderGroup>(() => {
    if (initialRules && "op" in initialRules) {
      return fromRules(initialRules) as BuilderGroup;
    }
    if (initialRules) {
      return { id: newId(), kind: "group", op: "AND", children: [fromRules(initialRules)] };
    }
    return newGroup();
  });
  const [name, setName] = useState(initialName ?? "");
  const [description, setDescription] = useState("");
  const [createdByAi, setCreatedByAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const rules = useMemo(() => toRules(root), [root]);
  const parsed = useMemo(() => SegmentRulesSchema.safeParse(rules), [rules]);

  const updateNode = useCallback((id: string, fn: (n: BuilderNode) => BuilderNode) => {
    setRoot((prev) => transform(prev, id, fn) as BuilderGroup);
  }, []);
  const addCondition = useCallback((groupId: string) => {
    updateNode(groupId, (n) =>
      n.kind === "group" ? { ...n, children: [...n.children, newCondition()] } : n,
    );
  }, [updateNode]);
  const addGroup = useCallback((groupId: string) => {
    updateNode(groupId, (n) =>
      n.kind === "group" ? { ...n, children: [...n.children, newGroup()] } : n,
    );
  }, [updateNode]);
  const removeNode = useCallback((id: string) => {
    setRoot((prev) => removeFrom(prev, id));
  }, []);

  // AI assist: populate the (editable) builder from a generated rule tree.
  const applyAi = useCallback((result: AiSegmentResult) => {
    if (!result.rules) {
      return;
    }
    const node = fromRules(result.rules);
    setRoot(
      node.kind === "group"
        ? node
        : { id: newId(), kind: "group", op: "AND", children: [node] },
    );
    setCreatedByAi(true);
    if (result.suggestedName) {
      setName((prev) => prev || result.suggestedName);
    }
  }, []);

  const handleSave = async () => {
    if (!parsed.success || !name.trim()) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          rules,
          createdByAi,
        }),
      });
      if (!res.ok) {
        throw new Error(`Save failed (${res.status})`);
      }
      const segment = (await res.json()) as { id: string };
      onSaved?.(segment.id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-5">
        <AiPromptBox onApply={applyAi} />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Segment name (e.g. High spenders gone quiet)"
            className="sm:max-w-sm"
            aria-label="Segment name"
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            aria-label="Segment description"
          />
        </div>

        {parsed.success && (
          <p className="text-sm text-muted-foreground">
            Targets customers where{" "}
            <span className="text-foreground">{describeRules(rules)}</span>
          </p>
        )}

        <GroupEditor
          group={root}
          depth={1}
          isRoot
          onUpdate={updateNode}
          onAddCondition={addCondition}
          onAddGroup={addGroup}
          onRemove={removeNode}
        />
      </div>

      <PreviewPanel
        rules={parsed.success ? rules : null}
        canSave={parsed.success && name.trim().length > 0}
        saving={saving}
        saveError={saveError}
        onSave={handleSave}
      />
    </div>
  );
}

const EXAMPLE_PROMPTS = [
  "high spenders in Mumbai or Delhi who haven't ordered in 90 days",
  "subscribers who have never placed an order",
  "wholesale customers who signed up in the last 30 days",
];

function AiPromptBox({ onApply }: { onApply: (result: AiSegmentResult) => void }) {
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "done"; result: AiSegmentResult }
  >({ status: "idle" });

  const submit = async (text?: string) => {
    const trimmed = (text ?? prompt).trim();
    if (!trimmed || state.status === "loading") {
      return;
    }
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/ai/segment-from-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: trimmed }),
      });
      if (!res.ok) {
        throw new Error(`AI request failed (${res.status})`);
      }
      const result = (await res.json()) as AiSegmentResult;
      setState({ status: "done", result });
      onApply(result);
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "AI request failed.",
      });
    }
  };

  return (
    <div className="rounded-lg border border-copper/30 bg-copper/5 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-copper">
        <Sparkles className="size-4" /> Describe your audience
      </div>
      <div className="flex gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submit();
            }
          }}
          placeholder="high spenders in Mumbai or Delhi who haven't ordered in 90 days"
          aria-label="Describe the audience in plain English"
        />
        <Button onClick={() => void submit()} disabled={state.status === "loading" || !prompt.trim()}>
          {state.status === "loading" ? "Thinking…" : "Generate"}
        </Button>
      </div>

      {state.status === "idle" && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Try:</span>
          {EXAMPLE_PROMPTS.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setPrompt(example);
                void submit(example);
              }}
              className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-copper/50 hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {state.status === "error" && (
        <p className="mt-2 text-sm text-destructive">{state.message}</p>
      )}
      {state.status === "done" && (
        <p
          className={cn(
            "mt-2 text-sm",
            state.result.rules ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {state.result.rules ? "Applied below — edit anything. " : ""}
          {state.result.explanation}
        </p>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  depth,
  isRoot,
  onUpdate,
  onAddCondition,
  onAddGroup,
  onRemove,
}: {
  group: BuilderGroup;
  depth: number;
  isRoot?: boolean;
  onUpdate: (id: string, fn: (n: BuilderNode) => BuilderNode) => void;
  onAddCondition: (groupId: string) => void;
  onAddGroup: (groupId: string) => void;
  onRemove: (id: string) => void;
}) {
  const setOp = (op: "AND" | "OR") =>
    onUpdate(group.id, (n) => (n.kind === "group" ? { ...n, op } : n));

  return (
    <div className={cn("rounded-lg border border-border/60 p-3", !isRoot && "bg-secondary/30")}>
      <div className="mb-3 flex items-center justify-between">
        <div className="inline-flex overflow-hidden rounded-md border border-border/60 text-xs font-medium">
          {(["AND", "OR"] as const).map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => setOp(op)}
              className={cn(
                "px-3 py-1.5 transition-colors",
                group.op === op
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {op}
            </button>
          ))}
        </div>
        {!isRoot && (
          <Button variant="ghost" size="sm" onClick={() => onRemove(group.id)} aria-label="Remove group">
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {group.children.map((child) =>
          child.kind === "group" ? (
            <GroupEditor
              key={child.id}
              group={child}
              depth={depth + 1}
              onUpdate={onUpdate}
              onAddCondition={onAddCondition}
              onAddGroup={onAddGroup}
              onRemove={onRemove}
            />
          ) : (
            <ConditionEditor
              key={child.id}
              condition={child}
              onUpdate={onUpdate}
              onRemove={onRemove}
              removable={group.children.length > 1 || !isRoot}
            />
          ),
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => onAddCondition(group.id)}>
          <Plus className="size-3.5" /> Condition
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onAddGroup(group.id)}
          disabled={depth >= MAX_SEGMENT_DEPTH}
          title={depth >= MAX_SEGMENT_DEPTH ? `Max nesting depth is ${MAX_SEGMENT_DEPTH}` : undefined}
        >
          <Plus className="size-3.5" /> Group
        </Button>
      </div>
    </div>
  );
}

function ConditionEditor({
  condition,
  onUpdate,
  onRemove,
  removable,
}: {
  condition: BuilderCondition;
  onUpdate: (id: string, fn: (n: BuilderNode) => BuilderNode) => void;
  onRemove: (id: string) => void;
  removable: boolean;
}) {
  const def = fieldDef(condition.field);

  const patch = (changes: Partial<BuilderCondition>) =>
    onUpdate(condition.id, (n) => (n.kind === "condition" ? { ...n, ...changes } : n));

  const onFieldChange = (field: SegmentField) => {
    const nextCmp = fieldDef(field).comparators[0];
    patch({ field, cmp: nextCmp, value: defaultValueFor(field, nextCmp) });
  };

  const onCmpChange = (cmp: SegmentComparator) => {
    // City switches value shape between single (eq/neq) and array (in).
    if (def.kind === "city") {
      patch({ cmp, value: defaultValueFor(condition.field, cmp) });
    } else {
      patch({ cmp });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-background p-2">
      <Select
        value={condition.field}
        onValueChange={(value) => onFieldChange(value as SegmentField)}
      >
        <SelectTrigger aria-label="Field" className="h-9 w-44">
          {def.label}
        </SelectTrigger>
        <SelectContent>
          {SEGMENT_FIELD_DEFS.map((d) => (
            <SelectItem key={d.field} value={d.field}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={condition.cmp}
        onValueChange={(value) => onCmpChange(value as SegmentComparator)}
      >
        <SelectTrigger aria-label="Comparator" className="h-9 w-40">
          {COMPARATOR_LABELS[condition.cmp]}
        </SelectTrigger>
        <SelectContent>
          {def.comparators.map((cmp) => (
            <SelectItem key={cmp} value={cmp}>
              {COMPARATOR_LABELS[cmp]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ValueInput condition={condition} onChange={(value) => patch({ value })} />

      {removable && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={() => onRemove(condition.id)}
          aria-label="Remove condition"
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
}

function ValueInput({
  condition,
  onChange,
}: {
  condition: BuilderCondition;
  onChange: (value: BuilderValue) => void;
}) {
  const def = fieldDef(condition.field);

  if (def.kind === "money") {
    const rupees = typeof condition.value === "number" ? Math.round(condition.value / 100) : 0;
    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
          ₹
        </span>
        <Input
          type="number"
          min={0}
          value={rupees}
          onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)) * 100)}
          className="w-32 pl-6"
          aria-label="Amount in rupees"
        />
      </div>
    );
  }

  if (def.kind === "count" || def.kind === "days") {
    return (
      <Input
        type="number"
        min={0}
        value={typeof condition.value === "number" ? condition.value : 0}
        onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
        className="w-28"
        aria-label={def.kind === "days" ? "Days" : "Count"}
      />
    );
  }

  if (def.kind === "tags") {
    return (
      <>
        <Input
          list="tag-suggestions"
          value={typeof condition.value === "string" ? condition.value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="tag"
          className="w-44"
          aria-label="Tag"
        />
        <datalist id="tag-suggestions">
          {TAG_SUGGESTIONS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </>
    );
  }

  // city
  if (condition.cmp === "in") {
    const text = Array.isArray(condition.value) ? condition.value.join(", ") : "";
    return (
      <Input
        value={text}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        placeholder="Mumbai, Delhi"
        className="w-56"
        aria-label="Cities (comma separated)"
      />
    );
  }
  return (
    <>
      <Input
        list="city-suggestions"
        value={typeof condition.value === "string" ? condition.value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="City"
        className="w-44"
        aria-label="City"
      />
      <datalist id="city-suggestions">
        {CITY_SUGGESTIONS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </>
  );
}

function PreviewPanel({
  rules,
  canSave,
  saving,
  saveError,
  onSave,
}: {
  rules: SegmentRules | null;
  canSave: boolean;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
}) {
  const [state, setState] = useState<
    { status: "idle" } | { status: "loading" } | { status: "loaded"; data: SegmentPreview } | { status: "error"; message: string }
  >({ status: "idle" });
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!rules) {
      setState({ status: "idle" });
      return;
    }
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }
    const controller = new AbortController();
    debounceRef.current = window.setTimeout(() => {
      setState({ status: "loading" });
      fetch("/api/segments/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`Preview failed (${res.status})`);
          }
          return (await res.json()) as SegmentPreview;
        })
        .then((data) => setState({ status: "loaded", data }))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setState({
              status: "error",
              message: error instanceof Error ? error.message : "Preview failed.",
            });
          }
        });
    }, 350);
    return () => {
      controller.abort();
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [rules]);

  return (
    <aside className="flex h-fit flex-col gap-4 rounded-lg border border-border/60 p-5 lg:sticky lg:top-20">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="size-4" /> Live preview
      </div>

      {state.status === "idle" && (
        <p className="text-sm text-muted-foreground">
          Complete the conditions to see how many customers match.
        </p>
      )}
      {state.status === "loading" && <Skeleton className="h-10 w-32" />}
      {state.status === "error" && <p className="text-sm text-destructive">{state.message}</p>}
      {state.status === "loaded" && (
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-4xl font-semibold tabular-nums">
              {formatNumber(state.data.count)}
            </div>
            <div className="text-sm text-muted-foreground">customers match</div>
          </div>
          {state.data.sample.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Top matches
              </span>
              {state.data.sample.map((customer) => (
                <div key={customer.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">{customer.name}</span>
                  <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
                    {formatRupees(customer.totalSpend)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-2">
        <Button onClick={onSave} disabled={!canSave || saving}>
          {saving ? "Saving…" : "Save segment"}
        </Button>
        {!canSave && (
          <p className="text-xs text-muted-foreground">Name the segment to save it.</p>
        )}
        {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      </div>

      {rules && (
        <Badge variant="outline" className="w-fit font-mono text-[10px] text-muted-foreground">
          {state.status === "loaded" ? "synced" : "editing"}
        </Badge>
      )}
    </aside>
  );
}
