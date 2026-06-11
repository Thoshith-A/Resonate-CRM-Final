import type { Prisma } from "@prisma/client";
import type { SegmentRules } from "@resonate/shared";
import { prisma } from "../db";
import { compileRules } from "./compile";

export type CreateSegmentInput = {
  name: string;
  description?: string;
  rules: SegmentRules;
  createdByAi?: boolean;
};

/** Persist a segment, snapshotting its current audience count for the list. */
export async function createSegment(input: CreateSegmentInput) {
  const where = compileRules(input.rules);
  const lastPreviewCount = await prisma.customer.count({ where });

  return prisma.segment.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      rules: input.rules as unknown as Prisma.InputJsonValue,
      createdByAi: input.createdByAi ?? false,
      lastPreviewCount,
    },
  });
}
