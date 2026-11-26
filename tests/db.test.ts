// Integration tests against a real Postgres. Run with DATABASE_URL set (CI uses a postgres:16 service).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookAppointment, cancelAppointment, rescheduleAppointment } from "@/lib/booking";
import { DENTISTS } from "@/lib/clinic";
import type { Sql } from "@/lib/db";
import { getDashboardState, resetDemo } from "@/lib/state";
import { runToolCall } from "@/lib/tools";
import { handleVapiMessage, secretMatches } from "@/lib/vapi-handler";

const url = process.env.DATABASE_URL;
const NOW = DateTime.fromISO("2026-11-30T08:00", { zone: "America/New_York" }).toJSDate();
const caller = (n: number) => ({ patient_name: `Test Caller ${n}`, phone: `415555${String(1000 + n)}` });

describe.skipIf(!url)("with Postgres", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(url!, { max: 12, prepare: false, onnotice: () => {} });
    await sql.unsafe(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
  });
  afterAll(async () => sql?.end());
  beforeEach(async () => {
    await sql`truncate tool_calls, staff_tasks, calls, appointments`;
    for (const d of DENTISTS) await sql`insert into dentists (id, name) values (${d.id}, ${d.name}) on conflict do nothing`;
  });

  const count = async () => Number((await sql`select count(*)::int as n from appointments where status = 'booked'`)[0].n);

  it("fills the second dentist, then refuses with alternatives", async () => {
    const a = await bookAppointment(sql, { ...caller(1), appointment_type: "checkup", start: "2026-11-30T10:00" }, { now: NOW });
    const b = await bookAppointment(sql, { ...caller(2), appointment_type: "checkup", start: "2026-11-30T10:00" }, { now: NOW });
    const c = await bookAppointment(sql, { ...caller(3), appointment_type: "checkup", start: "2026-11-30T10:00" }, { now: NOW });
    expect(a.kind).toBe("booked");
    expect(b.kind).toBe("booked");
    expect(a.kind === "booked" && b.kind === "booked" && a.dentist.id !== b.dentist.id).toBe(true);
    expect(c.kind).toBe("rejected");
    expect(c.kind === "rejected" && c.alternatives.length).toBeGreaterThan(0);
  });

  it("lets exactly one of 10 simultaneous callers take the same chair", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        bookAppointment(sql, { ...caller(i), appointment_type: "cleaning", start: "2026-12-01T14:00", dentist_id: "dr-patel" }, { now: NOW }),
      ),
    );
    expect(attempts.filter((r) => r.kind === "booked")).toHaveLength(1);
    expect(await count()).toBe(1);
  });

  it("the database itself rejects an overlapping insert", async () => {
    const start = DateTime.fromISO("2026-12-02T09:00", { zone: "America/New_York" }).toJSDate();
    const mid = new Date(start.getTime() + 30 * 60_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    await sql`insert into appointments (code, dentist_id, patient_name, phone, appointment_type, starts_at, ends_at) values ('AAAAA', 'dr-patel', 'A', '4155550001', 'cleaning', ${start}, ${end})`;
    await expect(
      sql`insert into appointments (code, dentist_id, patient_name, phone, appointment_type, starts_at, ends_at) values ('BBBBB', 'dr-patel', 'B', '4155550002', 'checkup', ${mid}, ${end})`,
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("returns the existing booking when the agent repeats itself", async () => {
    const args = { ...caller(1), appointment_type: "checkup" as const, start: "2026-11-30T11:00" };
    const first = await bookAppointment(sql, args, { now: NOW });
    const again = await bookAppointment(sql, args, { now: NOW });
    expect(first.kind).toBe("booked");
    expect(again.kind).toBe("already_booked");
    expect(await count()).toBe(1);
  });

  it("refuses to put one caller in two chairs at once", async () => {
    await bookAppointment(sql, { ...caller(1), appointment_type: "cleaning", start: "2026-11-30T14:00" }, { now: NOW });
    const r = await bookAppointment(sql, { ...caller(1), appointment_type: "checkup", start: "2026-11-30T14:30" }, { now: NOW });
    expect(r.kind === "rejected" && r.reason).toBe("patient_conflict");
  });

  it("replays a duplicated webhook instead of booking twice", async () => {
    const call = { id: "call_tool_1", name: "book_appointment", arguments: { ...caller(5), appointment_type: "checkup", start: "2026-11-30T15:00" }, callId: "c1" };
    const [r1, r2, r3] = await Promise.all([runToolCall(sql, call, NOW), runToolCall(sql, call, NOW), runToolCall(sql, call, NOW)]);
    expect("result" in r1 && r1.result).toMatch(/^BOOKED/);
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(await count()).toBe(1);
  });

  it("accepts arguments as a JSON string and reports missing fields", async () => {
    const ok = await runToolCall(sql, { id: "t2", name: "check_availability", arguments: JSON.stringify({ appointment_type: "checkup" }) }, NOW);
    expect("result" in ok && ok.result).toContain("Open times");
    const bad = await runToolCall(sql, { id: "t3", name: "book_appointment", arguments: { appointment_type: "checkup" } }, NOW);
    expect("result" in bad && bad.result).toContain("Missing or invalid details");
  });

  it("moves an appointment atomically, and keeps it if the new time is taken", async () => {
    const booked = await bookAppointment(sql, { ...caller(1), appointment_type: "checkup", start: "2026-12-01T09:00", dentist_id: "dr-patel" }, { now: NOW });
    if (booked.kind !== "booked") throw new Error("setup failed");
    // Fill 10:00 for both dentists.
    await bookAppointment(sql, { ...caller(2), appointment_type: "checkup", start: "2026-12-01T10:00" }, { now: NOW });
    await bookAppointment(sql, { ...caller(3), appointment_type: "checkup", start: "2026-12-01T10:00" }, { now: NOW });

    const blocked = await rescheduleAppointment(sql, { confirmation_code: booked.appt.code, phone: caller(1).phone, new_start: "2026-12-01T10:00" }, { now: NOW });
    expect(blocked.kind).toBe("rejected");
    const [still] = await sql`select status from appointments where id = ${booked.appt.id}`;
    expect(still.status).toBe("booked");

    const moved = await rescheduleAppointment(sql, { confirmation_code: booked.appt.code, phone: caller(1).phone, new_start: "2026-12-01T09:30" }, { now: NOW });
    expect(moved.kind).toBe("rescheduled");
    const [old] = await sql`select status from appointments where id = ${booked.appt.id}`;
    expect(old.status).toBe("cancelled");
    expect(await count()).toBe(3);
  });

  it("can shift an appointment into a slot that overlaps its own old time", async () => {
    const b = await bookAppointment(sql, { ...caller(1), appointment_type: "cleaning", start: "2026-12-02T09:00", dentist_id: "dr-patel" }, { now: NOW });
    if (b.kind !== "booked") throw new Error("setup failed");
    const r = await rescheduleAppointment(sql, { confirmation_code: b.appt.code, phone: caller(1).phone, new_start: "2026-12-02T09:30" }, { now: NOW });
    expect(r.kind).toBe("rescheduled");
  });

  it("only cancels when code and phone both match", async () => {
    const b = await bookAppointment(sql, { ...caller(1), appointment_type: "checkup", start: "2026-12-03T09:00" }, { now: NOW });
    if (b.kind !== "booked") throw new Error("setup failed");
    expect((await cancelAppointment(sql, { confirmation_code: b.appt.code, phone: "4155559999" }, NOW)).kind).toBe("not_found");
    const spokenCode = b.appt.code.split("").join(" ").toLowerCase();
    expect((await cancelAppointment(sql, { confirmation_code: spokenCode, phone: caller(1).phone }, NOW)).kind).toBe("cancelled");
    expect(await count()).toBe(0);
  });

  it("handles Vapi tool-calls and end-of-call-report messages", async () => {
    const res = await handleVapiMessage(
      sql,
      {
        message: {
          type: "tool-calls",
          call: { id: "call_abc" },
          toolCallList: [
            { id: "tc1", type: "function", function: { name: "book_appointment", arguments: { ...caller(7), appointment_type: "checkup", start: "2026-11-30T09:00" } } },
            { id: "tc2", type: "function", function: { name: "flag_for_staff", arguments: { urgency: "emergency", reason: "Swollen jaw, severe pain", phone: caller(7).phone } } },
          ],
        },
      },
      NOW,
    );
    expect(res.status).toBe(200);
    const { results } = res.json as { results: { toolCallId: string; result: string }[] };
    expect(results.map((r) => r.toolCallId)).toEqual(["tc1", "tc2"]);
    expect(results[0].result).toMatch(/^BOOKED/);

    await handleVapiMessage(sql, {
      message: {
        type: "end-of-call-report", call: { id: "call_abc" }, endedReason: "customer-ended-call",
        startedAt: "2026-11-30T13:00:00Z", endedAt: "2026-11-30T13:02:05Z", cost: 0.21,
        artifact: { transcript: "User: my number is 415 555 1007", messages: [] },
      },
    }, NOW);

    const state = await getDashboardState(sql, NOW);
    expect(state.calls[0]).toMatchObject({ callId: "call_abc", durationSec: 125, costUsd: 0.21 });
    expect(state.calls[0].outcomes.sort()).toEqual(["booked", "flagged"]);
    expect(state.calls[0].transcript).toContain("[phone number]");
    expect(state.tasks[0].phone).toBe("•••• ••07");
    expect(state.appointments[0].patient).toBe("Test 7."); // "Test Caller 7" -> first name + last initial
  });

  it("seeds a believable demo schedule without overlaps", async () => {
    const { seeded } = await resetDemo(sql, NOW);
    expect(seeded).toBeGreaterThan(5);
    expect(await count()).toBe(seeded);
  });
});

describe("webhook secret", () => {
  it("compares in constant time and rejects missing values", () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abd", "abc")).toBe(false);
    expect(secretMatches(null, "abc")).toBe(false);
    expect(secretMatches("abc", undefined)).toBe(false);
  });
});
