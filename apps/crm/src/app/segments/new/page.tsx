import type { Metadata } from "next";
import Link from "next/link";
import { TopNav } from "@/components/app-shell/top-nav";
import { NewSegmentForm } from "@/components/segments/new-segment-form";

export const metadata: Metadata = {
  title: "New segment · Resonate",
};

export default function NewSegmentPage() {
  return (
    <div className="min-h-svh bg-background">
      <TopNav />
      <main className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-8">
          <Link href="/segments" className="text-sm text-muted-foreground hover:text-foreground">
            ← Segments
          </Link>
          <h1 className="mt-2 font-display text-3xl tracking-tight">New segment</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build nested AND/OR rules and watch the audience size update live.
          </p>
        </header>
        <NewSegmentForm />
      </main>
    </div>
  );
}
