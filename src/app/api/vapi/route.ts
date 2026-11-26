import { getSql } from "@/lib/db";
import { handleVapiMessage, secretMatches, SECRET_HEADER } from "@/lib/vapi-handler";

export const maxDuration = 20;

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get(SECRET_HEADER), process.env.VAPI_WEBHOOK_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const { status, json } = await handleVapiMessage(getSql(), body, new Date());
  return Response.json(json, { status });
}
