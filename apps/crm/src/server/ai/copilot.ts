import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { ChannelSchema } from "@resonate/shared";
import { getAiModel } from "./provider";
import { segmentFromText } from "./segmentFromText";
import { draftMessages } from "./draftMessages";
import { previewSegment } from "../segments/previewSegment";
import { createSegment } from "../segments/createSegment";
import { createCampaign } from "../campaigns/createCampaign";
import { sendCampaign } from "../campaigns/sendCampaign";
import { MERGE_FIELDS } from "../campaigns/template";

/**
 * The campaign copilot (SPEC §9.4 / Phase 8). Claude/Gemini drives the SAME
 * `src/server` functions the UI calls — one domain layer, two consumers. The
 * tools take plain-English audiences (mapped via the Phase-3 segmentFromText
 * path), so the model never hand-builds a rule AST and a hallucinated field is
 * still structurally impossible. create_and_send_campaign is gated on explicit
 * user confirmation by the system prompt.
 */

export type CopilotMessage = { role: "user" | "assistant"; content: string };
export type CopilotToolEvent = { name: string; ok: boolean; summary: string; campaignUrl?: string };
export type CopilotResult = { text: string; toolEvents: CopilotToolEvent[] };

const nf = new Intl.NumberFormat("en-IN");
const mergeList = MERGE_FIELDS.map((f) => `{{${f}}}`).join(", ");

const SYSTEM_PROMPT = `You are Resonate's campaign copilot for Brewline, an Indian specialty-coffee D2C brand. You take a marketer from idea → live campaign using your tools, which call the very same backend the app's UI uses.

Tools:
- preview_segment(audience): estimate how many customers match a plain-English audience. ALWAYS preview before proposing a send, so you cite a real count.
- draft_message(objective, audienceDescription, channel, brandVoice?): get 3 on-brand variants. Personalise with these merge fields ONLY: ${mergeList}.
- create_and_send_campaign(campaignName, audience, channel, messageTemplate, objective?): creates the segment + campaign and SENDS it to the whole audience.

How to work:
1. Preview the audience first and report the real count.
2. Propose a message (offer to draft variants), then restate the plan: audience size + channel + the exact message text.
3. Only call create_and_send_campaign AFTER the user clearly confirms they want to send (e.g. "yes, send it"). If they haven't confirmed, ask — never send unprompted.

Rules:
- Channels: WHATSAPP, SMS (keep ≤160 chars), EMAIL, RCS. Default to WHATSAPP unless told otherwise.
- Segmentable attributes: total spend, order count, average order value, days since last order, days since signup, city, tags. If an audience needs anything else, say what's possible instead.
- Be concise and concrete. Always state real numbers (audience counts, send results) in your replies so the user sees what happened.`;

function buildTools() {
  return {
    preview_segment: tool({
      description:
        "Estimate the audience for a plain-English description. Returns how many Brewline customers match plus a few examples. Use before proposing or sending a campaign.",
      inputSchema: z.object({
        audience: z
          .string()
          .min(3)
          .describe("e.g. 'high spenders in Mumbai who haven't ordered in 90 days'"),
      }),
      execute: async ({ audience }) => {
        const seg = await segmentFromText(audience);
        if (!seg.rules) {
          return { ok: false, summary: `Couldn't map "${audience}" to a segment`, explanation: seg.explanation };
        }
        const preview = await previewSegment(seg.rules);
        return {
          ok: true,
          summary: `Previewed "${seg.suggestedName || audience}" → ${nf.format(preview.count)} customers`,
          count: preview.count,
          suggestedName: seg.suggestedName,
          explanation: seg.explanation,
          sample: preview.sample.map((c) => ({ name: c.name, city: c.city })),
        };
      },
    }),
    draft_message: tool({
      description:
        "Draft 3 on-brand message variants for an objective + channel. Use once the audience is known.",
      inputSchema: z.object({
        objective: z.string().min(3),
        audienceDescription: z.string().min(3),
        channel: ChannelSchema,
        brandVoice: z.string().optional(),
      }),
      execute: async (input) => {
        const res = await draftMessages(input);
        return {
          ok: true,
          summary: `Drafted ${res.variants.length} message variants`,
          variants: res.variants,
          degraded: res.degraded,
        };
      },
    }),
    create_and_send_campaign: tool({
      description:
        "Create a segment + campaign for the audience and SEND it through the channel simulator. This contacts the entire audience — call ONLY after the user has explicitly confirmed the audience and the message.",
      inputSchema: z.object({
        campaignName: z.string().min(1),
        audience: z.string().min(3),
        channel: ChannelSchema,
        messageTemplate: z
          .string()
          .min(1)
          .describe(`Message body. Merge fields allowed: ${mergeList}`),
        objective: z.string().optional(),
      }),
      execute: async ({ campaignName, audience, channel, messageTemplate, objective }) => {
        const seg = await segmentFromText(audience);
        if (!seg.rules) {
          return {
            ok: false,
            summary: `Couldn't map "${audience}" to a segment — nothing sent`,
            explanation: seg.explanation,
          };
        }
        const segment = await createSegment({
          name: seg.suggestedName || campaignName,
          description: audience,
          rules: seg.rules,
          createdByAi: true,
        });
        const campaign = await createCampaign({
          name: campaignName,
          objective,
          segmentId: segment.id,
          channel,
          messageTemplate,
        });
        const sent = await sendCampaign(campaign.id);
        return {
          ok: true,
          summary: `Created & sent "${campaignName}" → ${nf.format(sent.sent)} of ${nf.format(sent.audienceSize)} accepted`,
          campaignId: campaign.id,
          campaignUrl: `/campaigns/${campaign.id}`,
          audienceSize: sent.audienceSize,
          accepted: sent.sent,
          failed: sent.failed,
        };
      },
    }),
  };
}

/**
 * Run one copilot turn over the conversation so far. Multi-step: the model can
 * preview → draft → (on confirmation) send within a single call, up to 8 steps.
 * Tool failures degrade to `ok:false` events rather than throwing.
 */
export async function runCopilot(messages: CopilotMessage[]): Promise<CopilotResult> {
  const model = getAiModel(); // throws ApiError(503) if no provider key

  const modelMessages: ModelMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    tools: buildTools(),
    messages: modelMessages,
    stopWhen: stepCountIs(8),
  });

  const toolEvents: CopilotToolEvent[] = [];
  for (const step of result.steps) {
    for (const tr of step.toolResults ?? []) {
      const out = tr.output as { ok?: boolean; summary?: string; campaignUrl?: string } | undefined;
      toolEvents.push({
        name: tr.toolName,
        ok: out?.ok ?? true,
        summary: out?.summary ?? tr.toolName,
        ...(out?.campaignUrl ? { campaignUrl: out.campaignUrl } : {}),
      });
    }
  }

  const text =
    result.text.trim() ||
    (toolEvents.length
      ? toolEvents[toolEvents.length - 1]?.summary ?? "Done."
      : "I'm not sure how to help with that yet — try describing an audience.");

  return { text, toolEvents };
}
