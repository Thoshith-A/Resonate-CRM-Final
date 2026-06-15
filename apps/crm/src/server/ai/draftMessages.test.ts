import { describe, expect, it } from "vitest";
import { DraftMessagesInputSchema } from "./draftMessages";

// "Draft with Resonate" must never fail validation on fields the marketer can't
// see or control (objective is optional; audience is derived from the segment;
// brand voice has no UI length cap). These guard against a regression to the
// old `objective.min(1)` / `audienceDescription.min(1)` 422s.
describe("DraftMessagesInputSchema — never 422s on a reasonable draft request", () => {
  const base = {
    audienceDescription: "Days since last order at least 90 AND City is one of Mumbai, Delhi",
    channel: "WHATSAPP" as const,
    brandVoice: "warm, premium, concise",
  };

  it("accepts a blank objective and defaults it", () => {
    const result = DraftMessagesInputSchema.safeParse({ ...base, objective: "" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.objective.length).toBeGreaterThan(0);
  });

  it("accepts a missing objective", () => {
    const result = DraftMessagesInputSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("accepts a blank/missing audience description and defaults it", () => {
    const blank = DraftMessagesInputSchema.safeParse({ ...base, audienceDescription: "" });
    expect(blank.success).toBe(true);
    expect(blank.success && blank.data.audienceDescription.length).toBeGreaterThan(0);

    const withoutAudience = { objective: "", channel: base.channel, brandVoice: base.brandVoice };
    expect(DraftMessagesInputSchema.safeParse(withoutAudience).success).toBe(true);
  });

  it("accepts an over-long brand voice instead of rejecting (clamped at use)", () => {
    const result = DraftMessagesInputSchema.safeParse({ ...base, brandVoice: "x".repeat(500) });
    expect(result.success).toBe(true);
  });

  it("clamps an over-long objective/audience instead of rejecting", () => {
    const result = DraftMessagesInputSchema.safeParse({
      ...base,
      objective: "y".repeat(2000),
      audienceDescription: "z".repeat(2000),
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.objective.length).toBe(300);
    expect(result.success && result.data.audienceDescription.length).toBe(500);
  });

  // There is intentionally NO rejecting outer length cap: Zod runs .max() before
  // .transform(), so any cap would 422 a long paste before the clamp can run.
  it("accepts and clamps an enormous paste rather than 422-ing", () => {
    const result = DraftMessagesInputSchema.safeParse({
      ...base,
      objective: "y".repeat(50_000),
      audienceDescription: "z".repeat(50_000),
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.objective.length).toBe(300);
    expect(result.success && result.data.audienceDescription.length).toBe(500);
  });

  it("still rejects an unknown channel", () => {
    const result = DraftMessagesInputSchema.safeParse({ ...base, objective: "", channel: "PIGEON" });
    expect(result.success).toBe(false);
  });
});
