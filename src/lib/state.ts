// Dashboard data (with caller details masked) and demo reset/seed.
import { DateTime } from "luxon";
import { APPOINTMENT_TYPES, CLINIC, DENTISTS, type AppointmentType } from "./clinic";
import { newCode } from "./booking";
import type { Sql } from "./db";
import { openSlotsOnDay } from "./slots";

/** "Maria Gonzalez" → "Maria G." — the public dashboard never shows full names. */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Only the last two digits are shown. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `•••• ••${phone.slice(-2)}`;
}

export type DashboardState = {
  now: string;
  timezone: string;
  appointments: {
    id: string; code: string; dentist: string; patient: string; type: string;
    startsAt: string; endsAt: string; seeded: boolean; createdAt: string; fromCall: boolean;
  }[];
  tasks: { id: string; urgency: "emergency" | "callback"; reason: string; patient: string | null; phone: string | null; createdAt: string }[];
  calls: {
    callId: string; endedAt: string | null; endedReason: string | null; durationSec: number | null;
    costUsd: number | null; outcomes: string[]; transcript: string | null;
  }[];
};

export async function getDashboardState(sql: Sql, now: Date): Promise<DashboardState> {
  const from = DateTime.fromJSDate(now, { zone: CLINIC.timezone }).startOf("day").toJSDate();
  const to = DateTime.fromJSDate(now, { zone: CLINIC.timezone }).plus({ days: 7 }).endOf("day").toJSDate();

  const [appts, tasks, calls] = await Promise.all([
    sql<{ id: string; code: string; dentist_id: string; patient_name: string; appointment_type: AppointmentType; starts_at: Date; ends_at: Date; seeded: boolean; created_at: Date; call_id: string | null }[]>`
      select id, code, dentist_id, patient_name, appointment_type, starts_at, ends_at, seeded, created_at, call_id
      from appointments where status = 'booked' and starts_at >= ${from} and starts_at <= ${to}
      order by starts_at, dentist_id`,
    sql<{ id: string; urgency: "emergency" | "callback"; reason: string; patient_name: string | null; phone: string | null; created_at: Date }[]>`
      select id, urgency, reason, patient_name, phone, created_at from staff_tasks
      where not done order by created_at desc limit 10`,
    sql<{ call_id: string; started_at: Date | null; ended_at: Date | null; ended_reason: string | null; cost_usd: string | null; transcript: string | null; outcomes: string[] | null }[]>`
      select c.call_id, c.started_at, c.ended_at, c.ended_reason, c.cost_usd, c.transcript,
        (select array_agg(distinct t.outcome) from tool_calls t
          where t.call_id = c.call_id and t.outcome in ('booked','rescheduled','cancelled','flagged')) as outcomes
      from calls c order by coalesce(c.ended_at, c.created_at) desc limit 8`,
  ]);

  const dentistName = (id: string) => DENTISTS.find((d) => d.id === id)?.name ?? id;
  return {
    now: now.toISOString(),
    timezone: CLINIC.timezone,
    appointments: appts.map((a) => ({
      id: a.id, code: a.seeded ? a.code : `${a.code.slice(0, 2)}•••`,
      dentist: dentistName(a.dentist_id), patient: maskName(a.patient_name),
      type: APPOINTMENT_TYPES[a.appointment_type].label,
      startsAt: a.starts_at.toISOString(), endsAt: a.ends_at.toISOString(),
      seeded: a.seeded, createdAt: a.created_at.toISOString(), fromCall: a.call_id !== null,
    })),
    tasks: tasks.map((t) => ({
      id: t.id, urgency: t.urgency, reason: t.reason,
      patient: t.patient_name ? maskName(t.patient_name) : null, phone: maskPhone(t.phone),
      createdAt: t.created_at.toISOString(),
    })),
    calls: calls.map((c) => ({
      callId: c.call_id,
      endedAt: c.ended_at?.toISOString() ?? null,
      endedReason: c.ended_reason,
      durationSec: c.started_at && c.ended_at ? Math.round((c.ended_at.getTime() - c.started_at.getTime()) / 1000) : null,
      costUsd: c.cost_usd === null ? null : Number(c.cost_usd),
      outcomes: c.outcomes ?? [],
      transcript: c.transcript ? maskTranscript(c.transcript) : null,
    })),
  };
}

/** Strip phone-number-like digit runs from transcripts before showing them publicly. */
export function maskTranscript(t: string): string {
  return t.replace(/(\+?\d[\d\s().-]{5,}\d)/g, (m) => (m.replace(/\D/g, "").length >= 7 ? "[phone number]" : m));
}

const SEED_PATIENTS = ["Maria Gonzalez", "James Carter", "Priya Shah", "Tom Becker", "Aisha Johnson", "Liam O'Neill", "Grace Kim", "Daniel Rossi"];
const SEED_TYPES: AppointmentType[] = ["cleaning", "checkup", "checkup", "cleaning", "consultation", "checkup", "cleaning", "checkup"];

/** Wipes demo data and books a believable spread of seeded appointments over the next few open days. */
export async function resetDemo(sql: Sql, now: Date): Promise<{ seeded: number }> {
  return sql.begin(async (tx) => {
    await tx`delete from tool_calls`;
    await tx`delete from staff_tasks`;
    await tx`delete from calls`;
    await tx`delete from appointments`;
    await tx`insert into dentists ${tx(DENTISTS.map((d) => ({ id: d.id, name: d.name })))} on conflict (id) do update set name = excluded.name`;

    let seeded = 0;
    let day = DateTime.fromJSDate(now, { zone: CLINIC.timezone }).startOf("day");
    const busy: { dentistId: string; start: Date; end: Date }[] = [];
    const rows: Record<string, string | Date | boolean>[] = [];
    // Fill roughly every third open slot on the next 4 open days, so the schedule looks lived-in
    // but there is plenty of room left to book.
    for (let daysUsed = 0, guard = 0; daysUsed < 4 && guard < 14; guard++, day = day.plus({ days: 1 })) {
      const slots = openSlotsOnDay(day, "checkup", busy, now);
      if (!slots.length) continue;
      daysUsed++;
      for (let i = 1; i < slots.length; i += 3) {
        const type = SEED_TYPES[seeded % SEED_TYPES.length];
        const s = slots[i];
        const end = new Date(s.start.getTime() + APPOINTMENT_TYPES[type].minutes * 60_000);
        if (busy.some((b) => b.dentistId === s.dentistId && b.start < end && b.end > s.start)) continue;
        const fits = openSlotsOnDay(day, type, busy, now, DENTISTS.filter((d) => d.id === s.dentistId)).some((x) => x.local === s.local);
        if (!fits) continue;
        rows.push({
          code: newCode(), dentist_id: s.dentistId, patient_name: SEED_PATIENTS[seeded % SEED_PATIENTS.length],
          phone: "555010" + String(1000 + seeded).slice(-4), appointment_type: type, starts_at: s.start, ends_at: end, seeded: true,
        });
        busy.push({ dentistId: s.dentistId, start: s.start, end });
        seeded++;
      }
    }
    // One round trip for the whole demo week (codes are random; a collision just fails this reset, retried next run).
    if (rows.length) await tx`insert into appointments ${tx(rows)}`;
    return { seeded };
  });
}
