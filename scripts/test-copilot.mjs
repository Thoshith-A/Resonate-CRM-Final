// Drives the copilot endpoint through a full preview → draft → send conversation.
const BASE = "http://localhost:3000";
const messages = [];

async function turn(userText) {
  messages.push({ role: "user", content: userText });
  const res = await fetch(`${BASE}/api/ai/copilot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.log(`\n[${res.status}]`, JSON.stringify(body));
    return body;
  }
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`USER: ${userText}`);
  for (const e of body.toolEvents ?? []) {
    console.log(`  · [tool] ${e.name} ${e.ok ? "✓" : "✗"} — ${e.summary}${e.campaignUrl ? "  (" + e.campaignUrl + ")" : ""}`);
  }
  console.log(`ASSISTANT: ${body.text}`);
  messages.push({ role: "assistant", content: body.text });
  return body;
}

await turn("Find high spenders in Mumbai who haven't ordered in 90 days.");
await turn("Nice. Draft a warm WhatsApp win-back offering 15% off.");
const final = await turn("Perfect — go ahead and create and send it, call it 'Copilot win-back'.");

const sendEvent = (final.toolEvents ?? []).find((e) => e.name === "create_and_send_campaign");
console.log(`\n==============================================`);
console.log(sendEvent?.ok ? `SEND OK → ${sendEvent.campaignUrl}` : "SEND did NOT happen");
