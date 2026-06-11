import { z } from "zod";

/**
 * The single error envelope shape used at every API boundary in both
 * services: `{ error: { code, message } }`.
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
