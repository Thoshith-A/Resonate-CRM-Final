"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatNumber, formatRupees } from "@/lib/format";
import type {
  CampaignInsights as CampaignInsightsData,
  RoutingSummary,
} from "@/server/campaigns/getCampaignInsights";
import { buildParticles, STATUS_HEX } from "@/lib/delivery-particles";
import { CHANNEL_HEX } from "./ChannelSelector";
import { CampaignSummary } from "./campaign-summary";
import { SendTimeSection } from "./send-time-section";
import { DeliveryFeed } from "./delivery-feed";
import { DeliveryUniverse } from "./DeliveryUniverse";
import { statusBadgeVariant, statusLabel } from "./status";

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string; notFound?: boolean }
  | { status: "loaded"; data: CampaignInsightsData };

const POLL_MS = 3000;

const formatPct = (value: number): string => `${value.toFixed(1)}%`;

/** Neutral near-white for the "Delivered" milestone (default), distinct from the
 * green "Delivered, not read" status. */
const DELIVERED_WHITE = "#e5e7eb";

/**
 * A stable signature of every stat the AI summary depends on. The summary card
 * re-summarises only when this changes, so identical polls cost nothing.
 */
const funnelSignature = (data: CampaignInsightsData): string => {
  const f = data.funnel;
  return [
    data.status,
    f.sent,
    f.delivered,
    f.read,
    f.clicked,
    f.failed,
    data.attributedRevenue,
    data.attributedOrders,
  ].join("|");
};

export function CampaignInsights({ id }: { id: string }) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  // Guards re-entrant resume calls: at most one /send is in flight at a time.
  const resumingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    // Finish a send that hasn't fully dispatched yet. A /send is budget-bounded
    // and resumable (see sendCampaign.ts): if the campaign is still SENDING with
    // QUEUED rows — because the first request hit its time budget or timed out —
    // re-invoking /send drains the next wave. Polling keeps calling until the
    // outbox is empty and the campaign settles COMPLETED.
    const resumeIfStalled = (data: CampaignInsightsData) => {
      if (data.status !== "SENDING" || data.statusCounts.QUEUED <= 0 || resumingRef.current) {
        return;
      }
      resumingRef.current = true;
      fetch(`/api/campaigns/${id}/send`, { method: "POST" })
        .catch(() => {})
        .finally(() => {
          resumingRef.current = false;
        });
    };

    const load = (initial: boolean) => {
      if (initial) {
        setState({ status: "loading" });
      }
      fetch(`/api/campaigns/${id}`, { signal: controller.signal })
        .then(async (res) => {
          // A 404 means the campaign doesn't exist (e.g. the demo was reset) —
          // a terminal, not-found state, not a retryable error.
          if (res.status === 404) {
            if (!cancelled) {
              setState({
                status: "error",
                message: "This campaign no longer exists — it may have been reset or deleted.",
                notFound: true,
              });
            }
            return null;
          }
          if (!res.ok) {
            throw new Error(`Request failed (${res.status})`);
          }
          return (await res.json()) as CampaignInsightsData;
        })
        .then((data) => {
          if (data && !cancelled) {
            setState({ status: "loaded", data });
            resumeIfStalled(data);
          }
        })
        .catch((error: unknown) => {
          if (cancelled || controller.signal.aborted) {
            return;
          }
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Failed to load campaign.",
          });
        });
    };

    load(true);
    const interval = window.setInterval(() => load(false), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [id, reloadKey]);

  return (
    <div className="flex flex-col gap-8">
      <Link
        href="/dashboard"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Dashboard
      </Link>

      {state.status === "loading" ? (
        <LoadingState />
      ) : state.status === "error" ? (
        <div className="rounded-lg border border-border/60 py-16 text-center">
          {state.notFound ? (
            <>
              <p className="font-display text-lg tracking-tight">Campaign not found</p>
              <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
              <Link
                href="/dashboard"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
              >
                Back to dashboard
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{state.message}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Retry
              </Button>
            </>
          )}
        </div>
      ) : (
        <Loaded data={state.data} />
      )}
    </div>
  );
}

function Loaded({ data }: { data: CampaignInsightsData }) {
  // Particles are derived from the live per-status counts the poll already
  // returns — no per-row fetch. O(n) and recomputed only on each 3s poll.
  const particles = buildParticles(data.statusCounts);
  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-2xl tracking-tight">{data.name}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          {data.channelStrategy === "AI_ROUTED" ? (
            <Badge
              variant="outline"
              className="border-[#a78bfa]/40 bg-[#a78bfa]/10 text-[#a78bfa]"
            >
              ✦ AI-routed
            </Badge>
          ) : (
            <Badge variant="outline">{data.channel}</Badge>
          )}
          <span>{data.segmentName}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{formatNumber(data.audienceSize)} recipients</span>
          <span aria-hidden>·</span>
          <Badge variant={statusBadgeVariant(data.status)}>
            {statusLabel(data.status, data.channel)}
          </Badge>
          {data.sendStrategy === "SMART_WINDOWS" ? (
            <span className="flex items-center gap-1 text-[#a78bfa]" title="Smart Windows enabled">
              <Clock className="size-3.5" /> Smart Windows
            </span>
          ) : null}
          {data.objective ? (
            <>
              <span aria-hidden>·</span>
              <span className="italic">{data.objective}</span>
            </>
          ) : null}
        </div>
      </header>

      <div className="overflow-hidden rounded-xl border border-white/5 shadow-2xl">
        <DeliveryUniverse
          particles={particles}
          campaignName={data.name}
          campaignStatus={data.status as "DRAFT" | "SENDING" | "COMPLETED" | "FAILED"}
        />
      </div>

      <StatStrip data={data} />

      {data.channelStrategy === "AI_ROUTED" && data.routingSummary ? (
        <ChannelRoutingCard summary={data.routingSummary} />
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <FunnelCard data={data} />
        <FailureCard data={data} />
      </div>

      {data.sendStrategy === "SMART_WINDOWS" ? <SendTimeSection campaignId={data.id} /> : null}

      <CampaignSummary
        campaignId={data.id}
        funnelKey={funnelSignature(data)}
        isTerminal={data.status === "COMPLETED" || data.status === "FAILED"}
      />

      <Card>
        <CardHeader>
          <CardTitle>Live delivery feed</CardTitle>
        </CardHeader>
        <CardContent>
          <DeliveryFeed campaignId={data.id} channel={data.channel} />
        </CardContent>
      </Card>
    </>
  );
}

function StatStrip({ data }: { data: CampaignInsightsData }) {
  const readLabel = data.channel === "EMAIL" ? "Opened %" : "Read %";
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <Stat label="Audience" value={formatNumber(data.audienceSize)} />
      <Stat label="Delivered %" value={formatPct(data.deliveredPct)} />
      <Stat label={readLabel} value={formatPct(data.readPct)} valueColor={STATUS_HEX.READ} />
      <Stat label="Clicked %" value={formatPct(data.clickedPct)} valueColor={STATUS_HEX.CLICKED} />
      <Stat
        label="Attributed revenue"
        value={formatRupees(data.attributedRevenue)}
        sub={`${formatNumber(data.attributedOrders)} orders`}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Hex colour for the value — matches the factor's colour in the galaxy/funnel. */
  valueColor?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn("mt-1 text-2xl font-medium tabular-nums", !valueColor && "text-foreground")}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

const ROUTING_CHANNELS: Array<{
  key: "whatsapp" | "rcs" | "email" | "sms";
  channel: keyof typeof CHANNEL_HEX;
  label: string;
}> = [
  { key: "whatsapp", channel: "WHATSAPP", label: "WhatsApp" },
  { key: "rcs", channel: "RCS", label: "RCS" },
  { key: "email", channel: "EMAIL", label: "Email" },
  { key: "sms", channel: "SMS", label: "SMS" },
];

function ChannelRoutingCard({ summary }: { summary: RoutingSummary }) {
  const total = summary.whatsapp + summary.sms + summary.email + summary.rcs || 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="text-[#a78bfa]">✦</span> Channel routing
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {ROUTING_CHANNELS.map(({ key, channel }) => {
            const pctOf = (summary[key] / total) * 100;
            return pctOf > 0 ? (
              <div
                key={channel}
                style={{ width: `${pctOf}%`, backgroundColor: CHANNEL_HEX[channel] }}
                title={`${channel}: ${summary[key]}`}
              />
            ) : null;
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {ROUTING_CHANNELS.filter(({ key }) => summary[key] > 0).map(({ key, channel, label }) => (
            <span
              key={channel}
              className="flex items-center gap-1.5 tabular-nums text-muted-foreground"
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: CHANNEL_HEX[channel] }} />
              <span className="text-foreground">{formatNumber(summary[key])}</span> {label} ·{" "}
              {Math.round((summary[key] / total) * 100)}%
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Chosen per customer by {summary.model || "the AI router"}.
        </p>
      </CardContent>
    </Card>
  );
}

function FunnelCard({ data }: { data: CampaignInsightsData }) {
  const { funnel, channel } = data;
  const readStageLabel = channel === "EMAIL" ? "Opened" : "Read";
  const stages: { label: string; count: number; color: string }[] = [
    { label: "Sent", count: funnel.sent, color: STATUS_HEX.SENT },
    // "Delivered" (the cumulative milestone) is the neutral default white; the
    // green is reserved for "Delivered, not read" (status DELIVERED in the galaxy).
    { label: "Delivered", count: funnel.delivered, color: DELIVERED_WHITE },
    { label: readStageLabel, count: funnel.read, color: STATUS_HEX.READ },
    { label: "Clicked", count: funnel.clicked, color: STATUS_HEX.CLICKED },
  ];
  const denom = funnel.audience > 0 ? funnel.audience : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Funnel</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {stages.map((stage) => {
          const pctOfAudience = (stage.count / denom) * 100;
          return (
            <div key={stage.label} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">{stage.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatNumber(stage.count)} · {pctOfAudience.toFixed(1)}%
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${Math.min(100, pctOfAudience)}%`, backgroundColor: stage.color }}
                />
              </div>
            </div>
          );
        })}
        {funnel.failed > 0 ? (
          <>
            <Separator className="my-1" />
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-destructive">Failed</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatNumber(funnel.failed)} · {((funnel.failed / denom) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-destructive transition-all duration-700 ease-out"
                  style={{ width: `${Math.min(100, (funnel.failed / denom) * 100)}%` }}
                />
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FailureCard({ data }: { data: CampaignInsightsData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Failure breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        {data.failures.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No failures.</p>
        ) : (
          <ul className="flex flex-col">
            {data.failures.map((bucket) => (
              <li
                key={bucket.reason}
                className="flex items-center justify-between gap-3 border-b border-border/40 py-2.5 text-sm last:border-b-0"
              >
                <span className="truncate">{bucket.reason.replace(/_/g, " ")}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatNumber(bucket.count)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-96" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
        ))}
      </div>
      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}
