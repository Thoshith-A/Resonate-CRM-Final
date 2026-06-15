import { generateText, type ModelMessage } from "ai";
import { getAiModel } from "./provider";
import { XENO_GUIDE_SYSTEM_PROMPT } from "./xenoGuidePrompt";

/**
 * Xeno Guide — free-form (markdown) help assistant. Unlike the campaign copilot
 * it has no tools: it answers from the system prompt's knowledge of Resonate
 * and returns plain markdown. Full conversation history is passed for multi-turn
 * context. Throws if no AI provider key is configured (the route maps that to a
 * friendly reply).
 */

export type GuideMessage = { role: "user" | "assistant"; content: string };

const OUT_OF_SCOPE_FALLBACK =
  "I'm here to help with Resonate only. Try asking about segments, campaigns, AI features, or analytics!";

/**
 * Canned knowledge base used when the live model is unavailable (provider
 * outage / depleted credits). Each topic has a few phrasings so repeated
 * questions don't return identical text. Matched by keyword against the latest
 * user message; falls back to a general overview.
 */
const GUIDE_FAQ: Array<{ match: RegExp; answers: string[] }> = [
  {
    match: /segment|audience|filter|target/,
    answers: [
      "**Creating a segment** is easy:\n\n1. Go to **Segments → New**.\n2. Either type your audience in plain English (e.g. *\"high spenders in Mumbai who haven't ordered in 90 days\"*) and let Resonate build the rules, **or** add conditions in the visual builder.\n3. Watch the live preview count update, then **Save**.\n\nYou can filter on spend, order count, average order value, recency, signup date, city, and tags.",
      "To build an **audience**, open **Segments → New**. Describe who you want in everyday language — Resonate converts it into precise rules you can fine-tune — or stack conditions yourself (spend, orders, recency, city, tags). The preview tells you exactly how many customers match before you save.",
    ],
  },
  {
    match: /campaign|send|message|draft|launch/,
    answers: [
      "**Running a campaign:**\n\n1. **Campaigns → New**, pick your segment.\n2. Set an objective and let Resonate **draft 3 message variants**, or write your own.\n3. Choose a channel strategy (single channel or **AI routing** per customer) and when to send.\n4. Hit **Send** and watch the delivery funnel and attributed revenue update live.",
      "Start a **campaign** from **Campaigns → New**: choose a segment, draft a message (Resonate suggests three variants), pick AI channel routing if you like, then send. The campaign page then shows the funnel filling — sent → delivered → read → clicked — in real time.",
    ],
  },
  {
    match: /attribut|revenue|conversion|roi|order/,
    answers: [
      "**Attribution** ties orders back to your campaign. When a customer clicks and then places an order shortly after, Resonate records it as an attributed conversion — so each campaign page shows **attributed revenue** and order count computed from real data, never estimated.",
      "Resonate tracks **revenue** per campaign: a click followed by a purchase is logged as an attributed order, and the campaign's revenue figure is the sum of those — reconciled to the database to the rupee.",
    ],
  },
  {
    match: /rout|channel|whatsapp|sms|email|rcs/,
    answers: [
      "**AI channel routing** picks the best channel for each customer — WhatsApp, RCS, SMS, or Email — based on signals like city tier, spend, order history, and tags, to maximise click-through. Turn it on in the campaign builder; you'll see the predicted channel mix before you send.",
      "With **channel routing**, Resonate chooses per-customer between WhatsApp/RCS/SMS/Email using each customer's profile, then shows you the resulting distribution (e.g. mostly RCS for premium buyers) right in the builder.",
    ],
  },
  {
    match: /window|timing|when|wave|smart/,
    answers: [
      "**Smart Windows** sends each customer at *their* most-engaged time of day, inferred from their past order timestamps. The waves play out and the funnel fills progressively — landing in a customer's peak window lifts the read rate.",
    ],
  },
  {
    match: /reset|demo|seed|sample data/,
    answers: [
      "**Reset demo** (top nav) wipes campaigns and re-seeds ~8,000 customers and their orders to a clean baseline — handy before a fresh walkthrough. You'll be asked for the admin key.",
    ],
  },
];

function cannedAnswer(question: string): string {
  const q = question.toLowerCase();
  // Vary selection per call so repeated questions aren't identical.
  const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
  for (const topic of GUIDE_FAQ) {
    if (topic.match.test(q)) return pick(topic.answers);
  }
  return pick([
    "I can help you navigate Resonate. Ask me how to **create a segment**, **run a campaign**, use **AI channel routing**, or read your **attribution** numbers.",
    "Happy to help! Try: *\"How do I create a segment?\"*, *\"How does AI routing work?\"*, or *\"Where do I see attributed revenue?\"*",
    "Resonate is an AI campaign copilot for D2C brands. I can walk you through segments, AI-drafted messages, channel routing, Smart Windows, and live delivery analytics — what would you like to do?",
  ]);
}

export async function runXenoGuide(messages: GuideMessage[]): Promise<string> {
  const modelMessages: ModelMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  try {
    const model = getAiModel(); // throws ApiError(503) if no provider key
    const result = await generateText({
      model,
      system: XENO_GUIDE_SYSTEM_PROMPT,
      messages: modelMessages,
    });
    const text = result.text.trim();
    if (text) return text;
    return OUT_OF_SCOPE_FALLBACK;
  } catch (error) {
    // Model unavailable (outage / depleted credits) — answer from the canned
    // knowledge base so the assistant stays useful instead of erroring.
    console.error("[ai] xeno-guide degraded:", error instanceof Error ? error.message : error);
    return cannedAnswer(lastUser);
  }
}
