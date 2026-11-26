import { connection } from "next/server";
import { getSql } from "@/lib/db";
import { resetDemo } from "@/lib/state";
import { secretMatches } from "@/lib/vapi-handler";

// Wipes and re-seeds the demo. Called by the daily cron (Authorization: Bearer CRON_SECRET)
// or manually with the same header.
async function handle(request: Request) {
  await connection();
  const auth = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(auth, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await resetDemo(getSql(), new Date());
  return Response.json({ ok: true, ...r });
}

export const GET = handle;
export const POST = handle;
