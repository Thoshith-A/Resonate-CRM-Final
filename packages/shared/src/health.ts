import { z } from "zod";

/**
 * Health contract shared by both services. Each service validates its own
 * response against this schema so a drift in either one fails loudly.
 */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.enum(["crm", "channel-sim"]),
  version: z.string(),
  time: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
