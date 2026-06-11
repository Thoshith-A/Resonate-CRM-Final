import type { Metadata } from "next";
import { TopNav } from "@/components/app-shell/top-nav";
import { SegmentsList } from "@/components/segments/segments-list";

export const metadata: Metadata = {
  title: "Segments · Resonate",
};

export default function SegmentsPage() {
  return (
    <div className="min-h-svh bg-background">
      <TopNav />
      <main className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-8">
          <h1 className="font-display text-3xl tracking-tight">Segments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Describe an audience with rules — Brewline&apos;s customers, filtered.
          </p>
        </header>
        <SegmentsList />
      </main>
    </div>
  );
}
