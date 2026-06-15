"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  PenLine,
  Rocket,
  Search,
  Send,
  Sparkles,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ── Endpoint contract: POST /api/ai/copilot ───────────────────────────────
// Locked shape (defined locally; server types are not imported).
type Role = "user" | "assistant";
type ToolName = "preview_segment" | "draft_message" | "create_and_send_campaign";

type ToolEvent = {
  name: string;
  ok: boolean;
  summary: string;
  campaignUrl?: string;
};

type CopilotResponse = { text: string; toolEvents: ToolEvent[] };
type ErrorEnvelope = { error?: { code?: string; message?: string } };

/** A turn in the visible conversation. `toolEvents`/`error` are UI-only. */
type ChatMessage = {
  role: Role;
  content: string;
  toolEvents?: ToolEvent[];
  error?: boolean;
};

// Cap the history we send so a long session stays under the route's max (40).
const MAX_HISTORY = 40;

const SUGGESTIONS = [
  "Find high spenders in Mumbai who haven't ordered in 90 days",
  "Draft a win-back WhatsApp for lapsed VIPs",
  "Create and send a 15% win-back to high spenders gone quiet",
] as const;

export function CopilotPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Abort any in-flight turn when the panel unmounts.
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  // Auto-scroll to the newest message (including the thinking placeholder).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  const send = (raw: string) => {
    const content = raw.trim();
    if (!content || pending) {
      return;
    }

    const history = [...messages, { role: "user" as const, content }];
    setMessages(history);
    setDraft("");
    setPending(true);

    const controller = new AbortController();
    controllerRef.current = controller;

    // Send role+content only — drop UI-only fields — and cap the history.
    const payload = history
      .slice(-MAX_HISTORY)
      .map(({ role, content: text }) => ({ role, content: text }));

    fetch("/api/ai/copilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: payload }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as ErrorEnvelope | null;
          throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
        }
        return (await res.json()) as CopilotResponse;
      })
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.text, toolEvents: data.toolEvents },
        ]);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: error instanceof Error ? error.message : "Something went wrong.",
            error: true,
          },
        ]);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPending(false);
        }
      });
  };

  const handleOpenChange = (next: boolean) => {
    // Closing mid-turn cancels the request; guard against late setState.
    if (!next) {
      controllerRef.current?.abort();
      setPending(false);
    }
    setOpen(next);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
        title="Open the AI campaign copilot"
      >
        <Sparkles className="size-4 text-copper" />
        Copilot
      </Button>

      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border/60 p-4">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-copper" />
            Copilot
          </SheetTitle>
          <SheetDescription>
            Describe a goal — I&apos;ll preview the audience, draft the message, and send it.
          </SheetDescription>
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 ? (
            <EmptyState onPick={send} disabled={pending} />
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((message, index) => (
                <MessageBubble
                  key={index}
                  message={message}
                  onNavigate={() => setOpen(false)}
                />
              ))}
              {pending ? <ThinkingBubble /> : null}
            </div>
          )}
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => send(draft)}
          disabled={pending}
        />
      </SheetContent>
    </Sheet>
  );
}

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Tell me who to reach and what to say. I&apos;ll size the audience, draft on-brand copy,
        and — once you confirm — create and send the campaign.
      </p>
      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Try</span>
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={disabled}
            onClick={() => onPick(suggestion)}
            className={cn(
              "rounded-lg border border-border/60 px-3 py-2 text-left text-sm transition-colors",
              "hover:border-copper/40 hover:bg-copper/5",
              "outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onNavigate,
}: {
  message: ChatMessage;
  onNavigate: () => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm whitespace-pre-wrap",
          message.error ? "bg-destructive/10 text-destructive" : "bg-secondary/50",
        )}
      >
        {message.content}
      </div>
      {message.toolEvents && message.toolEvents.length > 0 ? (
        <div className="flex w-full flex-col gap-1.5">
          {message.toolEvents.map((event, index) => (
            <ToolEventRow key={index} event={event} onNavigate={onNavigate} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const TOOL_ICONS: Record<ToolName, typeof Search> = {
  preview_segment: Search,
  draft_message: PenLine,
  create_and_send_campaign: Rocket,
};

function toolIcon(name: string) {
  return TOOL_ICONS[name as ToolName] ?? Send;
}

function ToolEventRow({
  event,
  onNavigate,
}: {
  event: ToolEvent;
  onNavigate: () => void;
}) {
  const Icon = toolIcon(event.name);
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        event.ok
          ? "border-copper/30 bg-copper/5 text-foreground"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", event.ok ? "text-copper" : "text-destructive")} />
      <span className="min-w-0 flex-1 truncate">{event.summary}</span>
      {event.ok && event.campaignUrl ? (
        <Link
          href={event.campaignUrl}
          onClick={onNavigate}
          className="inline-flex shrink-0 items-center gap-0.5 font-medium text-copper transition-colors hover:text-copper/80"
        >
          View
          <ArrowUpRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-secondary/50 px-3 py-2.5">
        <span className="sr-only">Working…</span>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  return (
    <div className="border-t border-border/60 p-4">
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={disabled}
          rows={1}
          placeholder="Describe a goal…"
          className="max-h-32 min-h-9 flex-1 resize-none py-2"
        />
        <Button
          size="icon"
          onClick={onSend}
          disabled={disabled || value.trim().length === 0}
          title="Send"
        >
          <Send className="size-4" />
          <span className="sr-only">Send</span>
        </Button>
      </div>
    </div>
  );
}
