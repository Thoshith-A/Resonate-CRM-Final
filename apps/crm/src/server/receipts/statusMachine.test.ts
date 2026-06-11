import { describe, expect, it } from "vitest";
import { foldEvents, type CommState, type FoldEvent } from "./statusMachine";

const sent: CommState = {
  status: "SENT",
  deliveredAt: null,
  readAt: null,
  clickedAt: null,
  failureReason: null,
};

const t = (iso: string) => new Date(iso);
const ev = (eventType: FoldEvent["eventType"], iso: string, reason?: string): FoldEvent => ({
  eventType,
  occurredAt: t(iso),
  reason,
});

describe("foldEvents — out of order", () => {
  it("CLICKED arriving before DELIVERED ends at CLICKED with both timestamps", () => {
    const result = foldEvents(sent, [
      ev("clicked", "2026-06-11T10:00:30.000Z"),
      ev("delivered", "2026-06-11T10:00:00.000Z"),
    ]);
    expect(result.status).toBe("CLICKED");
    expect(result.deliveredAt).toEqual(t("2026-06-11T10:00:00.000Z"));
    expect(result.clickedAt).toEqual(t("2026-06-11T10:00:30.000Z"));
    expect(result.readAt).toBeNull();
  });
});

describe("foldEvents — idempotency / duplicates", () => {
  it("a duplicate delivered does not change an already-DELIVERED row", () => {
    const delivered: CommState = {
      status: "DELIVERED",
      deliveredAt: t("2026-06-11T10:00:00.000Z"),
      readAt: null,
      clickedAt: null,
      failureReason: null,
    };
    const result = foldEvents(delivered, [ev("delivered", "2026-06-11T10:00:00.000Z")]);
    expect(result).toEqual(delivered);
  });

  it("folding the same delivered event twice is stable", () => {
    const once = foldEvents(sent, [ev("delivered", "2026-06-11T10:00:00.000Z")]);
    const twice = foldEvents(once, [ev("delivered", "2026-06-11T10:00:00.000Z")]);
    expect(twice).toEqual(once);
    expect(once.status).toBe("DELIVERED");
  });
});

describe("foldEvents — forward-only", () => {
  it("a late delivered never regresses a READ message", () => {
    const read: CommState = {
      status: "READ",
      deliveredAt: t("2026-06-11T10:00:00.000Z"),
      readAt: t("2026-06-11T10:01:00.000Z"),
      clickedAt: null,
      failureReason: null,
    };
    const result = foldEvents(read, [ev("delivered", "2026-06-11T10:00:05.000Z")]);
    expect(result.status).toBe("READ");
  });
});

describe("foldEvents — failure", () => {
  it("failed from SENT becomes FAILED with the reason", () => {
    const result = foldEvents(sent, [ev("failed", "2026-06-11T10:00:00.000Z", "blocked")]);
    expect(result.status).toBe("FAILED");
    expect(result.failureReason).toBe("blocked");
  });

  it("FAILED is terminal — a later delivered cannot reopen it", () => {
    const failed: CommState = {
      status: "FAILED",
      deliveredAt: null,
      readAt: null,
      clickedAt: null,
      failureReason: "bounce",
    };
    const result = foldEvents(failed, [ev("delivered", "2026-06-11T10:00:00.000Z")]);
    expect(result).toEqual(failed);
  });

  it("a failed alongside a delivered keeps real progress (DELIVERED wins)", () => {
    const result = foldEvents(sent, [
      ev("delivered", "2026-06-11T10:00:00.000Z"),
      ev("failed", "2026-06-11T10:00:01.000Z", "blocked"),
    ]);
    expect(result.status).toBe("DELIVERED");
    expect(result.deliveredAt).toEqual(t("2026-06-11T10:00:00.000Z"));
  });
});
