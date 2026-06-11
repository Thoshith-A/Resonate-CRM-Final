/**
 * Message template rendering. The marketer writes a template with
 * {{merge_fields}}; the send pipeline renders one message per customer
 * server-side. Pure and unit-tested (one of the three core test suites).
 *
 * Whitelisted merge fields: first_name, city, last_order_days_ago,
 * total_spend_rupees. Unknown placeholders are left intact (a template typo
 * shouldn't silently vanish text).
 */

const MERGE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(MERGE_RE, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

export type MergeCustomer = {
  name: string;
  city: string;
  lastOrderAt: Date | null;
  totalSpend: number;
};

const rupeeFormatter = new Intl.NumberFormat("en-IN");

/** Build the whitelisted merge variables for one customer. */
export function customerMergeVars(
  customer: MergeCustomer,
  now: Date = new Date(),
): Record<string, string> {
  const firstName = customer.name.trim().split(/\s+/)[0] || customer.name;
  const lastOrderDaysAgo = customer.lastOrderAt
    ? String(Math.max(0, Math.floor((now.getTime() - customer.lastOrderAt.getTime()) / 86_400_000)))
    : "a while";
  const totalSpendRupees = rupeeFormatter.format(Math.round(customer.totalSpend / 100));
  return {
    first_name: firstName,
    city: customer.city,
    last_order_days_ago: lastOrderDaysAgo,
    total_spend_rupees: totalSpendRupees,
  };
}

/** Convenience: render a template for a customer. */
export function renderForCustomer(
  template: string,
  customer: MergeCustomer,
  now: Date = new Date(),
): string {
  return renderTemplate(template, customerMergeVars(customer, now));
}
