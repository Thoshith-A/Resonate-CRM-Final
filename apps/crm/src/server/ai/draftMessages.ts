import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { ChannelSchema, type Channel } from "@resonate/shared";
import { MERGE_FIELDS, mergeFieldsUsed } from "../campaigns/template";
import { getAiModel } from "./provider";

export type MessageVariant = { label: string; text: string };
export type DraftMessagesResult = { variants: MessageVariant[]; degraded: boolean };

// "Draft with Resonate" must never 422 on the fields the marketer didn't (or
// couldn't) fill. The objective is optional in the builder; the audience
// description is derived from the selected segment's rules (the user never types
// it, but a deeply-nested segment can describe to a long string); and the brand
// voice is a free-text input with no length cap in the UI. So each text field is
// "soft": trimmed, defaulted when blank, and clamped to its working limit rather
// than rejected. The blank-objective default also reads naturally in the
// fallback templates and guides the model well.
const DEFAULT_OBJECTIVE = "come back and enjoy something special at Brewline";
const DEFAULT_AUDIENCE = "customers we'd love to re-engage";

const OBJECTIVE_LIMIT = 300;
const AUDIENCE_LIMIT = 500;
const VOICE_LIMIT = 120;

/**
 * Trim; default when blank, else clamp to `max`. Deliberately CLAMPS rather than
 * rejecting on length: Zod runs `.max()` before `.transform()`, so a `.max()`
 * guard would 422 a long paste before the clamp ever runs. Gross payloads are
 * bounded by the platform's request-body limit, not here — so this schema never
 * 422s on any string the UI can produce.
 */
function softText(max: number, fallback: string) {
  return (value: string | undefined): string => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed.slice(0, max) : fallback;
  };
}

export const DraftMessagesInputSchema = z.object({
  objective: z.string().optional().transform(softText(OBJECTIVE_LIMIT, DEFAULT_OBJECTIVE)),
  audienceDescription: z.string().optional().transform(softText(AUDIENCE_LIMIT, DEFAULT_AUDIENCE)),
  channel: ChannelSchema,
  // Plain optional, no length rejection — clamped to VOICE_LIMIT at the point of
  // use so it stays an optional key, which the copilot tool relies on.
  brandVoice: z.string().optional(),
});
export type DraftMessagesInput = z.infer<typeof DraftMessagesInputSchema>;

const DEFAULT_VOICE = "warm, premium, concise";
const SMS_LIMIT = 160;

const VariantSchema = z.object({
  label: z.string().min(1).max(40),
  text: z.string().min(1).max(1000),
});
const AiOutputSchema = z.object({ variants: z.array(VariantSchema).length(3) });

const mergeFieldList = MERGE_FIELDS.map((f) => `{{${f}}}`).join(", ");

function systemPrompt(channel: Channel, voice: string): string {
  const channelNote =
    channel === "SMS"
      ? `This is an SMS — every variant MUST be ≤ ${SMS_LIMIT} characters including merge fields. No links unless essential.`
      : channel === "WHATSAPP" || channel === "RCS"
        ? "This is a WhatsApp/RCS message — conversational, one or two short lines, an emoji is fine."
        : "This is an email body — a warm opening line and a clear call to action; keep it tight.";

  return `You are a senior copywriter for Brewline, an Indian specialty-coffee D2C brand (beans, equipment, subscriptions). Write campaign messages in a ${voice} voice.

Produce a JSON object: { "variants": [ { "label": string, "text": string } x3 ] } — exactly three distinct variants with short labels (e.g. "Direct", "Warm", "Playful").

${channelNote}

Personalisation: you MAY use ONLY these merge fields, written exactly with double braces: ${mergeFieldList}. ${MERGE_FIELDS.map((f) => `${f} = ${describeField(f)}`).join("; ")}. NEVER invent a merge field — any other {{token}} is forbidden and will be rejected.

Rules: write in English with rupee amounts where relevant; never promise discounts beyond the stated objective; no placeholder/lorem text; each variant should take a genuinely different angle.`;
}

function describeField(field: string): string {
  switch (field) {
    case "first_name":
      return "the customer's first name";
    case "city":
      return "their city";
    case "last_order_days_ago":
      return "days since their last order (a number, or 'a while')";
    case "total_spend_rupees":
      return "their lifetime spend in rupees, comma-formatted";
    default:
      return field;
  }
}

/** Reject variants that use unknown merge fields or break the SMS limit. */
function validateVariants(variants: MessageVariant[], channel: Channel): void {
  const allowed = new Set<string>(MERGE_FIELDS);
  for (const variant of variants) {
    const unknown = mergeFieldsUsed(variant.text).filter((f) => !allowed.has(f));
    if (unknown.length > 0) {
      throw new Error(`Variant "${variant.label}" uses unknown merge fields: ${unknown.join(", ")}`);
    }
    if (channel === "SMS" && variant.text.length > SMS_LIMIT) {
      throw new Error(
        `Variant "${variant.label}" is ${variant.text.length} chars; SMS limit is ${SMS_LIMIT}`,
      );
    }
  }
}

async function attempt(
  model: LanguageModel,
  input: DraftMessagesInput,
  voice: string,
  extra: string,
): Promise<MessageVariant[]> {
  const { object } = await generateObject({
    model,
    schema: AiOutputSchema,
    system: systemPrompt(input.channel, voice),
    prompt: `Audience: ${input.audienceDescription}\nObjective: ${input.objective}${extra}`,
  });
  validateVariants(object.variants, input.channel);
  return object.variants;
}

/**
 * Safe, editable starting points when the model is unavailable. Draws from a
 * pool of distinct angles and shuffles, so re-drafting yields different copy
 * each time rather than the same three lines. Uses only whitelisted merge
 * fields, so a fallback can never reference a field the renderer won't fill.
 */
function fallbackVariants(input: DraftMessagesInput): MessageVariant[] {
  const objective = input.objective.trim().replace(/\.$/, "");
  const pool: MessageVariant[] = [
    { label: "Direct", text: `Hi {{first_name}}, ${objective}. — Brewline ☕` },
    { label: "Warm", text: `Hi {{first_name}}, we've missed you in {{city}}. ${objective} — your next cup's on us. ☕` },
    { label: "Short", text: `{{first_name}}, ${objective}. ☕ Brewline` },
    { label: "Playful", text: `Psst {{first_name}} 👀 your coffee's getting lonely. ${objective}! ☕ — Brewline` },
    { label: "Premium", text: `{{first_name}}, a little something from Brewline: ${objective}. Crafted for you in {{city}}. ✨` },
    { label: "Urgent", text: `Only this week, {{first_name}} — ${objective}. Don't miss it. ☕ Brewline` },
    { label: "Curious", text: `{{first_name}}, it's been {{last_order_days_ago}} days ☕ ${objective}. Ready for another?` },
  ];
  // Shuffle (Fisher–Yates) and take three distinct angles.
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const chosen = pool.slice(0, 3);
  if (input.channel === "SMS") {
    return chosen.map((v) => ({ ...v, text: v.text.slice(0, SMS_LIMIT) }));
  }
  return chosen;
}

/**
 * Draft 3 channel-appropriate message variants. One attempt, then one retry
 * with the validation error appended, then a graceful fallback (a safe
 * starting template) so the marketer is never left with an empty editor.
 * Merge fields are whitelisted, so a drafted message can never reference a
 * field the renderer wouldn't fill.
 */
export async function draftMessages(input: DraftMessagesInput): Promise<DraftMessagesResult> {
  const voice = input.brandVoice?.trim().slice(0, VOICE_LIMIT) || DEFAULT_VOICE;

  // Resolve the provider lazily here; if no key is configured at all, degrade to
  // safe starter copy rather than surfacing a 503. "Draft with Resonate" then
  // always returns three editable options — the same graceful path as a model
  // failure below — so a misconfigured deploy can't dead-end the marketer.
  let model: LanguageModel;
  try {
    model = getAiModel();
  } catch (error) {
    console.error(
      "[ai] draft-messages: no AI provider configured —",
      error instanceof Error ? error.message : error,
    );
    return { variants: fallbackVariants(input), degraded: true };
  }

  try {
    return { variants: await attempt(model, input, voice, ""), degraded: false };
  } catch (firstError) {
    const reason = firstError instanceof Error ? firstError.message : String(firstError);
    try {
      const variants = await attempt(
        model,
        input,
        voice,
        `\n\nYour previous attempt was rejected (${reason}). Use ONLY the allowed merge fields and respect the channel length limit.`,
      );
      return { variants, degraded: false };
    } catch (secondError) {
      console.error(
        "[ai] draft-messages failed:",
        secondError instanceof Error ? secondError.message : secondError,
      );
      return { variants: fallbackVariants(input), degraded: true };
    }
  }
}
