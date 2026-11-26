import { connection } from "next/server";
import { getSql } from "@/lib/db";
import { getDashboardState } from "@/lib/state";

export async function GET() {
  await connection(); // live data: render per request, never at build time
  const state = await getDashboardState(getSql(), new Date());
  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
}
