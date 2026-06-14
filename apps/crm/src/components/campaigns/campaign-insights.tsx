"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatNumber, formatRupees } from "@/lib/format";
import type { CampaignInsights as CampaignInsightsData } from "@/server/campaigns/getCampaignInsights";
import { CampaignSummary } from "./campaign-summary";
import { DeliveryFeed } from "./delivery-feed";
import { statusBadgeVariant, statusLabel } from "./status";

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string; notFound?: boolean }
  | { status: "loaded"; data: CampaignInsightsData };

const POLL_MS = 3000;

const formatPct = (value: number): string => `${value.toFixed(1)}%`;

export function CampaignInsights({ id }: { id: string }) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

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
  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-2xl tracking-tight">{data.name}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <Badge variant="outline">{data.channel}</Badge>
          <span>{data.segmentName}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{formatNumber(data.audienceSize)} recipients</span>
          <span aria-hidden>·</span>
          <Badge variant={statusBadgeVariant(data.status)}>
            {statusLabel(data.status, data.channel)}
          </Badge>
          {data.objective ? (
            <>
              <span aria-hidden>·</span>
              <span className="italic">{data.objective}</span>
            </>
          ) : null}
        </div>
      </header>

      <StatStrip data={data} />

      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <FunnelCard data={data} />
        <FailureCard data={data} />
      </div>

      <CampaignSummary campaignId={data.id} />

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
      <Stat label={readLabel} value={formatPct(data.readPct)} />
      <Stat label="Clicked %" value={formatPct(data.clickedPct)} accent />
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
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-medium tabular-nums",
          accent ? "text-copper" : "text-foreground",
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function FunnelCard({ data }: { data: CampaignInsightsData }) {
  const { funnel, channel } = data;
  const readStageLabel = channel === "EMAIL" ? "Opened" : "Read";
  const stages: { label: string; count: number }[] = [
    { label: "Sent", count: funnel.sent },
    { label: "Delivered", count: funnel.delivered },
    { label: readStageLabel, count: funnel.read },
    { label: "Clicked", count: funnel.clicked },
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
                  className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
                  style={{ width: `${Math.min(100, pctOfAudience)}%` }}
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
