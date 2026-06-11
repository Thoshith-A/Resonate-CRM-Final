import type { Customer } from "@prisma/client";
import type { CustomerInput } from "@resonate/shared";
import { prisma } from "../db";

/**
 * Upsert a customer. When an `externalId` is supplied the customer is keyed
 * on it (idempotent re-ingest); otherwise a new record is always created.
 * Aggregates are owned by order ingest and are never touched here.
 */
export async function ingestCustomer(input: CustomerInput): Promise<Customer> {
  const data = {
    name: input.name,
    email: input.email,
    phone: input.phone,
    city: input.city,
    tags: input.tags,
  };

  if (input.externalId) {
    return prisma.customer.upsert({
      where: { externalId: input.externalId },
      create: { externalId: input.externalId, ...data },
      update: data,
    });
  }

  return prisma.customer.create({ data });
}
