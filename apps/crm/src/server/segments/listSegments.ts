import type { SegmentRules } from "@resonate/shared";
import { prisma } from "../db";

export type SegmentListItem = {
  id: string;
  name: string;
  description: string | null;
  rules: SegmentRules;
  createdByAi: boolean;
  lastPreviewCount: number | null;
  createdAt: string;
};

/** All saved segments, most recent first. */
export async function listSegments(): Promise<SegmentListItem[]> {
  const segments = await prisma.segment.findMany({ orderBy: { createdAt: "desc" } });
  return segments.map((segment) => ({
    id: segment.id,
    name: segment.name,
    description: segment.description,
    rules: segment.rules as unknown as SegmentRules,
    createdByAi: segment.createdByAi,
    lastPreviewCount: segment.lastPreviewCount,
    createdAt: segment.createdAt.toISOString(),
  }));
}
