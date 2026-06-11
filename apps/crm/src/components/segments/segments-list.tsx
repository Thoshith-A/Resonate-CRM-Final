"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate, formatNumber } from "@/lib/format";
import { describeRules } from "@/lib/segment-describe";
import type { SegmentListItem } from "@/server/segments/listSegments";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; segments: SegmentListItem[] };

export function SegmentsList() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch("/api/segments", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        return (await res.json()) as { segments: SegmentListItem[] };
      })
      .then((data) => setState({ status: "loaded", segments: data.segments }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Failed to load segments.",
          });
        }
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Reusable audiences, compiled to a single indexed query.
        </p>
        <Link href="/segments/new" className={cn(buttonVariants({ size: "sm" }))}>
          <Plus className="size-4" /> New segment
        </Link>
      </div>

      {state.status === "loading" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      )}

      {state.status === "error" && (
        <div className="rounded-lg border border-border/60 p-10 text-center">
          <p className="text-sm text-muted-foreground">{state.message}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        </div>
      )}

      {state.status === "loaded" && state.segments.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/60 p-12 text-center">
          <p className="text-sm text-muted-foreground">No segments yet.</p>
          <Link href="/segments/new" className={cn(buttonVariants({ size: "sm" }), "mt-4")}>
            <Plus className="size-4" /> Create your first segment
          </Link>
        </div>
      )}

      {state.status === "loaded" && state.segments.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {state.segments.map((segment) => (
            <Card key={segment.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{segment.name}</CardTitle>
                  {segment.createdByAi && (
                    <Badge variant="secondary" className="gap-1">
                      <Sparkles className="size-3" /> AI
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {describeRules(segment.rules)}
                </p>
                <div className="flex items-center justify-between text-sm">
                  <span className="tabular-nums">
                    <span className="font-medium">
                      {segment.lastPreviewCount === null
                        ? "—"
                        : formatNumber(segment.lastPreviewCount)}
                    </span>{" "}
                    <span className="text-muted-foreground">customers</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(segment.createdAt)}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
