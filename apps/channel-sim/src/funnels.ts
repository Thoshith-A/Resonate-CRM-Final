import type { Channel } from "@resonate/shared";

/**
 * Per-channel engagement funnel parameters (SPEC §7). Every probability and
 * delay window lives in a named constant so a later phase can lift these into
 * env without touching the lifecycle logic. Delays are expressed in
 * milliseconds at SIM_SPEED=1; the lifecycle scheduler divides by the speed
 * multiplier at runtime.
 */

/** Inclusive-ish delay window [min, max] in ms (at SIM_SPEED=1). */
export interface DelayRange {
  readonly minMs: number;
  readonly maxMs: number;
}

export interface FunnelConfig {
  /** P(message is delivered) — otherwise it fails at the delivery step. */
  readonly deliveredRate: number;
  readonly deliveryDelay: DelayRange;
  /**
   * P(delivered message is read), and the read delay window. `null` when the
   * channel has no read signal (SMS), in which case clicks roll off delivery.
   */
  readonly readRate: number | null;
  readonly readDelay: DelayRange | null;
  /**
   * P(click). Rolled off the read step when the channel has reads, otherwise
   * off the delivered step.
   */
  readonly clickedRate: number;
  readonly clickDelay: DelayRange;
  /** Reasons drawn at random for a `failed` delivery event. */
  readonly failureReasons: readonly string[];
}

// ── WhatsApp ─────────────────────────────────────────────────────────────
const WHATSAPP_DELIVERED_RATE = 0.94;
const WHATSAPP_DELIVERY_DELAY: DelayRange = { minMs: 500, maxMs: 6000 };
const WHATSAPP_READ_RATE = 0.7;
const WHATSAPP_READ_DELAY: DelayRange = { minMs: 2000, maxMs: 45000 };
const WHATSAPP_CLICKED_RATE = 0.28;
const WHATSAPP_CLICK_DELAY: DelayRange = { minMs: 2000, maxMs: 30000 };
const WHATSAPP_FAILURE_REASONS = ["blocked", "expired"] as const;

// ── SMS ──────────────────────────────────────────────────────────────────
const SMS_DELIVERED_RATE = 0.96;
const SMS_DELIVERY_DELAY: DelayRange = { minMs: 500, maxMs: 6000 };
const SMS_CLICKED_RATE = 0.06;
const SMS_CLICK_DELAY: DelayRange = { minMs: 2000, maxMs: 30000 };
const SMS_FAILURE_REASONS = ["invalid_number", "carrier_reject"] as const;

// ── Email ────────────────────────────────────────────────────────────────
const EMAIL_DELIVERED_RATE = 0.9;
const EMAIL_DELIVERY_DELAY: DelayRange = { minMs: 1000, maxMs: 8000 };
const EMAIL_READ_RATE = 0.42; // "opened"
const EMAIL_READ_DELAY: DelayRange = { minMs: 5000, maxMs: 60000 };
const EMAIL_CLICKED_RATE = 0.09;
const EMAIL_CLICK_DELAY: DelayRange = { minMs: 2000, maxMs: 30000 };
const EMAIL_FAILURE_REASONS = ["bounce", "spam_block"] as const;

// ── RCS (same shape as WhatsApp, lower delivery) ───────────────────────────
const RCS_DELIVERED_RATE = 0.88;

const FUNNELS: Readonly<Record<Channel, FunnelConfig>> = {
  WHATSAPP: {
    deliveredRate: WHATSAPP_DELIVERED_RATE,
    deliveryDelay: WHATSAPP_DELIVERY_DELAY,
    readRate: WHATSAPP_READ_RATE,
    readDelay: WHATSAPP_READ_DELAY,
    clickedRate: WHATSAPP_CLICKED_RATE,
    clickDelay: WHATSAPP_CLICK_DELAY,
    failureReasons: WHATSAPP_FAILURE_REASONS,
  },
  SMS: {
    deliveredRate: SMS_DELIVERED_RATE,
    deliveryDelay: SMS_DELIVERY_DELAY,
    readRate: null,
    readDelay: null,
    clickedRate: SMS_CLICKED_RATE,
    clickDelay: SMS_CLICK_DELAY,
    failureReasons: SMS_FAILURE_REASONS,
  },
  EMAIL: {
    deliveredRate: EMAIL_DELIVERED_RATE,
    deliveryDelay: EMAIL_DELIVERY_DELAY,
    readRate: EMAIL_READ_RATE,
    readDelay: EMAIL_READ_DELAY,
    clickedRate: EMAIL_CLICKED_RATE,
    clickDelay: EMAIL_CLICK_DELAY,
    failureReasons: EMAIL_FAILURE_REASONS,
  },
  RCS: {
    deliveredRate: RCS_DELIVERED_RATE,
    deliveryDelay: WHATSAPP_DELIVERY_DELAY,
    readRate: WHATSAPP_READ_RATE,
    readDelay: WHATSAPP_READ_DELAY,
    clickedRate: WHATSAPP_CLICKED_RATE,
    clickDelay: WHATSAPP_CLICK_DELAY,
    failureReasons: WHATSAPP_FAILURE_REASONS,
  },
};

export function getFunnel(channel: Channel): FunnelConfig {
  return FUNNELS[channel];
}

/** One-line human summary for the boot log. */
export function funnelSummary(): string {
  return (Object.keys(FUNNELS) as Channel[])
    .map((channel) => {
      const f = FUNNELS[channel];
      const read = f.readRate === null ? "—" : f.readRate.toFixed(2);
      return `${channel} d=${f.deliveredRate.toFixed(2)} r=${read} c=${f.clickedRate.toFixed(2)}`;
    })
    .join(" | ");
}
