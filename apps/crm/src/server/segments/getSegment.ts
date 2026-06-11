import type { SegmentRules } from "@resonate/shared";
import { prisma } from "../db";
import { notFound } from "../api";
import type { SegmentListItem } from "./listSegments";

/** Load a single saved segment (e.g. to open it in the builder). */
export async function getSegment(id: string): Promise<SegmentListItem> {
  const segment = await prisma.segment.findUnique({ where: { id } });
  if (!segment) {
    throw notFound(`No segment with id ${id}`);
  }
  return {
    id: segment.id,
    name: segment.name,
    description: segment.description,
    rules: segment.rules as unknown as SegmentRules,
    createdByAi: segment.createdByAi,
    lastPreviewCount: segment.lastPreviewCount,
    createdAt: segment.createdAt.toISOString(),
  };
}
