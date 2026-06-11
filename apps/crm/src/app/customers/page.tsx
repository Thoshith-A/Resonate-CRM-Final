import type { Metadata } from "next";
import { TopNav } from "@/components/app-shell/top-nav";
import { CustomersExplorer } from "@/components/customers/customers-explorer";

export const metadata: Metadata = {
  title: "Customers · Resonate",
};

export default function CustomersPage() {
  return (
    <div className="min-h-svh bg-background">
      <TopNav />
      <main className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-8">
          <h1 className="font-display text-3xl tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Brewline&apos;s audience — spend, orders, and recency at a glance.
          </p>
        </header>
        <CustomersExplorer />
      </main>
    </div>
  );
}
