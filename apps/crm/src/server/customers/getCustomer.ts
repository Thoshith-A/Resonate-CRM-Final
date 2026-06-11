import type { OrderItem } from "@resonate/shared";
import { prisma } from "../db";
import { notFound } from "../api";

export type CustomerOrder = {
  id: string;
  amount: number;
  currency: string;
  items: OrderItem[];
  placedAt: string;
  source: string;
  attributedCampaignId: string | null;
};

export type CustomerCommunication = {
  id: string;
  channel: string;
  status: string;
  renderedMessage: string;
  campaignId: string;
  sentAt: string | null;
  updatedAt: string;
};

export type CustomerDetail = {
  id: string;
  externalId: string | null;
  name: string;
  email: string;
  phone: string;
  city: string;
  tags: string[];
  createdAt: string;
  totalSpend: number;
  orderCount: number;
  avgOrderValue: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  orders: CustomerOrder[];
  communications: CustomerCommunication[];
};

const RECENT_LIMIT = 20;

/** Full customer profile: aggregates + recent orders + recent communications. */
export async function getCustomer(id: string): Promise<CustomerDetail> {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      orders: { orderBy: { placedAt: "desc" }, take: RECENT_LIMIT },
      communications: { orderBy: { updatedAt: "desc" }, take: RECENT_LIMIT },
    },
  });

  if (!customer) {
    throw notFound(`No customer with id ${id}`);
  }

  return {
    id: customer.id,
    externalId: customer.externalId,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    city: customer.city,
    tags: customer.tags,
    createdAt: customer.createdAt.toISOString(),
    totalSpend: customer.totalSpend,
    orderCount: customer.orderCount,
    avgOrderValue: customer.avgOrderValue,
    firstOrderAt: customer.firstOrderAt ? customer.firstOrderAt.toISOString() : null,
    lastOrderAt: customer.lastOrderAt ? customer.lastOrderAt.toISOString() : null,
    orders: customer.orders.map((order) => ({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      items: order.items as unknown as OrderItem[],
      placedAt: order.placedAt.toISOString(),
      source: order.source,
      attributedCampaignId: order.attributedCampaignId,
    })),
    communications: customer.communications.map((comm) => ({
      id: comm.id,
      channel: comm.channel,
      status: comm.status,
      renderedMessage: comm.renderedMessage,
      campaignId: comm.campaignId,
      sentAt: comm.sentAt ? comm.sentAt.toISOString() : null,
      updatedAt: comm.updatedAt.toISOString(),
    })),
  };
}
