// Creates (or updates) the Vapi assistant from src/lib/assistant.ts.
// Usage:
//   VAPI_PRIVATE_KEY=... VAPI_WEBHOOK_SECRET=... APP_URL=https://your-app.vercel.app \
//   npx tsx scripts/create-assistant.ts [existing-assistant-id]
import { buildAssistant } from "../src/lib/assistant";

async function main() {
  const key = process.env.VAPI_PRIVATE_KEY;
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  if (!key || !secret || !appUrl) throw new Error("Set VAPI_PRIVATE_KEY, VAPI_WEBHOOK_SECRET and APP_URL");

  const existingId = process.argv[2];
  const body = buildAssistant({ webhookUrl: `${appUrl}/api/vapi`, webhookSecret: secret });
  const res = await fetch(existingId ? `https://api.vapi.ai/assistant/${existingId}` : "https://api.vapi.ai/assistant", {
    method: existingId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id?: string; message?: unknown };
  if (!res.ok) {
    console.error(`Vapi returned ${res.status}:`, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log(`${existingId ? "Updated" : "Created"} assistant ${json.id}`);
  console.log(`Set NEXT_PUBLIC_VAPI_ASSISTANT_ID=${json.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
