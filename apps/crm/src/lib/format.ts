/** Display helpers. Money is stored as integer paise; UI shows whole rupees. */

const rupeeFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("en-IN");

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Paise (integer) → "₹1,23,456". */
export function formatRupees(paise: number): string {
  return rupeeFormatter.format(Math.round(paise / 100));
}

/** Integer with Indian grouping → "12,34,567". */
export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

/** ISO string → "12 Jan 2025"; null → "—". */
export function formatDate(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return dateFormatter.format(new Date(iso));
}

/** Whole-day age of an ISO date relative to now; null → null. */
export function daysAgo(iso: string | null): number | null {
  if (!iso) {
    return null;
  }
  const diff = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
}
