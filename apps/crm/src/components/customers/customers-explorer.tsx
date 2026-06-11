"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatNumber, formatRupees } from "@/lib/format";
import type { CustomerListResult } from "@/server/customers/listCustomers";
import { CustomerDrawer } from "./customer-drawer";

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: CustomerListResult };

const PAGE_SIZE = 25;

export function CustomersExplorer() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Debounce the search box; reset to page 1 on a new query.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (debounced.trim()) {
      params.set("search", debounced.trim());
    }
    fetch(`/api/customers?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        return (await res.json()) as CustomerListResult;
      })
      .then((data) => setState({ status: "loaded", data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load customers.",
        });
      });
    return () => controller.abort();
  }, [debounced, page]);

  const total = state.status === "loaded" ? state.data.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, email, city, phone…"
            className="pl-9"
            aria-label="Search customers"
          />
        </div>
        {state.status === "loaded" && (
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
            {formatNumber(total)} customers
          </span>
        )}
      </div>

      <div className="rounded-lg border border-border/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Total spend</TableHead>
              <TableHead className="text-right">Last order</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.status === "loading" ? (
              <LoadingRows />
            ) : state.status === "error" ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">{state.message}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => setDebounced((value) => `${value} `.trimEnd())}
                  >
                    Retry
                  </Button>
                </TableCell>
              </TableRow>
            ) : state.data.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                  No customers match “{debounced}”.
                </TableCell>
              </TableRow>
            ) : (
              state.data.rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(row.id)}
                >
                  <TableCell>
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground">{row.email}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.city}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.tags.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        row.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.orderCount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRupees(row.totalSpend)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatDate(row.lastOrderAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm tabular-nums text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || state.status !== "loaded"}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || state.status !== "loaded"}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <CustomerDrawer customerId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: 6 }).map((__, j) => (
            <TableCell key={j}>
              <Skeleton className="h-5 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
