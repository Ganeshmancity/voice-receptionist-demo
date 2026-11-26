// Turns one Vapi server message into our response.
// Formats follow docs.vapi.ai/server-url/events (tool-calls, end-of-call-report).
import { timingSafeEqual } from "node:crypto";
import type { Sql } from "./db";
import { runToolCall, type ToolCallOutput } from "./tools";

export const SECRET_HEADER = "x-demo-secret";

export function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type VapiToolCall = { id: string; type?: string; function?: { name?: string; arguments?: unknown } };

type VapiMessage = {
  type?: string;
  call?: { id?: string };
  toolCallList?: VapiToolCall[];
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: number;
  artifact?: { transcript?: string; messages?: unknown[] };
};

export async function handleVapiMessage(
  sql: Sql,
  body: unknown,
  now: Date,
): Promise<{ status: number; json: unknown }> {
  const message = (body as { message?: VapiMessage } | null)?.message;
  if (!message?.type) return { status: 400, json: { error: "missing message.type" } };
  const callId = message.call?.id;

  if (message.type === "tool-calls") {
    const results: ToolCallOutput[] = [];
    // Sequential on purpose: "check, then book" in one turn must see its own writes.
    for (const tc of message.toolCallList ?? []) {
      if (!tc?.id || !tc.function?.name) continue;
      results.push(await runToolCall(sql, { id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? {}, callId }, now));
    }
    return { status: 200, json: { results } };
  }

  if (message.type === "end-of-call-report") {
    if (callId) {
      await sql`
        insert into calls (call_id, started_at, ended_at, ended_reason, transcript, messages, cost_usd)
        values (
          ${callId},
          ${message.startedAt ? new Date(message.startedAt) : null},
          ${message.endedAt ? new Date(message.endedAt) : now},
          ${message.endedReason ?? null},
          ${message.artifact?.transcript ?? null},
          ${message.artifact?.messages ? sql.json(message.artifact.messages as never) : null},
          ${typeof message.cost === "number" ? message.cost : null}
        )
        on conflict (call_id) do update set
          ended_at = excluded.ended_at, ended_reason = excluded.ended_reason,
          transcript = excluded.transcript, messages = excluded.messages, cost_usd = excluded.cost_usd`;
    }
    return { status: 200, json: { ok: true } };
  }

  // Other events (status-update etc.) are acknowledged and ignored.
  return { status: 200, json: { ok: true } };
}
