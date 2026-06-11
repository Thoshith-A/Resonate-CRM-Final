"use client";

import { useRouter } from "next/navigation";
import { SegmentBuilder } from "./segment-builder";

export function NewSegmentForm() {
  const router = useRouter();
  return (
    <SegmentBuilder
      onSaved={() => {
        router.push("/segments");
        router.refresh();
      }}
    />
  );
}
