import type { SegmentRules } from "@resonate/shared";
import { prisma } from "../db";
import { compileRules } from "./compile";

export type SegmentSampleCustomer = {
  id: string;
  name: string;
  city: string;
  totalSpend: number;
  orderCount: number;
  lastOrderAt: string | null;
};

export type SegmentPreview = {
  count: number;
  sample: SegmentSampleCustomer[];
};

/** Count the audience for a rule set + return the top 5 by spend as a sample. */
export async function previewSegment(rules: SegmentRules): Promise<SegmentPreview> {
  const where = compileRules(rules);
  const [count, sample] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: { totalSpend: "desc" },
      take: 5,
      select: {
        id: true,
        name: true,
        city: true,
        totalSpend: true,
        orderCount: true,
        lastOrderAt: true,
      },
    }),
  ]);

  return {
    count,
    sample: sample.map((customer) => ({
      ...customer,
      lastOrderAt: customer.lastOrderAt ? customer.lastOrderAt.toISOString() : null,
    })),
  };
}
