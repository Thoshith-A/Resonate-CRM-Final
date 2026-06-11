"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber, formatRupees } from "@/lib/format";
import type { CustomerDetail } from "@/server/customers/getCustomer";

type DrawerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: CustomerDetail };

/** Per-channel label: WhatsApp/RCS "read" and Email "opened" are both READ. */
function statusLabel(channel: string, status: string): string {
  if (status === "READ") {
    return channel === "EMAIL" ? "Opened" : "Read";
  }
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export function CustomerDrawer({
  customerId,
  onClose,
}: {
  customerId: string | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<DrawerState>({ status: "loading" });

  useEffect(() => {
    if (!customerId) {
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/customers/${customerId}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        return (await res.json()) as CustomerDetail;
      })
      .then((data) => setState({ status: "loaded", data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load customer.",
        });
      });
    return () => controller.abort();
  }, [customerId]);

  return (
    <Sheet open={customerId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {state.status === "loading" ? (
          <DrawerSkeleton />
        ) : state.status === "error" ? (
          <div className="p-6">
            <SheetHeader className="px-0">
              <SheetTitle>Couldn&apos;t load customer</SheetTitle>
              <SheetDescription>{state.message}</SheetDescription>
            </SheetHeader>
          </div>
        ) : (
          <DrawerBody data={state.data} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ data }: { data: CustomerDetail }) {
  return (
    <div className="flex flex-col gap-6 p-6">
      <SheetHeader className="px-0">
        <SheetTitle className="text-xl">{data.name}</SheetTitle>
        <SheetDescription>
          {data.email} · {data.phone} · {data.city}
        </SheetDescription>
      </SheetHeader>

      {data.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-4 tabular-nums">
        <Stat label="Total spend" value={formatRupees(data.totalSpend)} />
        <Stat label="Orders" value={formatNumber(data.orderCount)} />
        <Stat label="Avg order" value={formatRupees(data.avgOrderValue)} />
        <Stat label="Last order" value={formatDate(data.lastOrderAt)} />
      </dl>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          Orders ({data.orders.length})
        </h3>
        {data.orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.orders.map((order) => (
              <li
                key={order.id}
                className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate">
                    {order.items.map((item) => `${item.qty}× ${item.name}`).join(", ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(order.placedAt)}
                    {order.source === "CAMPAIGN" ? " · from campaign" : ""}
                  </p>
                </div>
                <span className="ml-3 shrink-0 font-medium tabular-nums">
                  {formatRupees(order.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          Communications ({data.communications.length})
        </h3>
        {data.communications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages sent yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.communications.map((comm) => (
              <li
                key={comm.id}
                className="rounded-md border border-border/60 px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                    {comm.channel}
                  </span>
                  <Badge variant="outline">{statusLabel(comm.channel, comm.status)}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-muted-foreground">
                  {comm.renderedMessage}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-medium">{value}</dd>
    </div>
  );
}

function DrawerSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
