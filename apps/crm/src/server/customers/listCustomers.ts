import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

export type CustomerListItem = {
  id: string;
  name: string;
  email: string;
  city: string;
  tags: string[];
  totalSpend: number;
  orderCount: number;
  lastOrderAt: string | null;
};

export type CustomerListResult = {
  rows: CustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ListCustomersParams = {
  search?: string;
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Paginated, searchable customer list backed by indexed columns. Search is a
 * case-insensitive match across name/email/city/phone.
 */
export async function listCustomers(
  params: ListCustomersParams,
): Promise<CustomerListResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));
  const search = params.search?.trim();

  const where: Prisma.CustomerWhereInput = search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { city: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
        ],
      }
    : {};

  const [total, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ lastOrderAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        email: true,
        city: true,
        tags: true,
        totalSpend: true,
        orderCount: true,
        lastOrderAt: true,
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      ...row,
      lastOrderAt: row.lastOrderAt ? row.lastOrderAt.toISOString() : null,
    })),
  };
}
