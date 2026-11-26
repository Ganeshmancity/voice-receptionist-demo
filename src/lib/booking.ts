// Database-backed receptionist actions. Every function returns plain data;
// tools.ts turns it into the sentence the voice agent reads.
import { randomInt } from "node:crypto";
import { DateTime } from "luxon";
import { APPOINTMENT_TYPES, CLINIC, DENTISTS, dentistById, type AppointmentType, type Dentist } from "./clinic";
import { isPgError, PG, type Q, type Sql } from "./db";
import { checkFit, findSlots, parseLocal, parseLocalDate, type BusyBlock, type RejectReason, type Slot } from "./slots";

export type Appointment = {
  id: string;
  code: string;
  dentist_id: string;
  patient_name: string;
  phone: string;
  appointment_type: AppointmentType;
  starts_at: Date;
  ends_at: Date;
  status: "booked" | "cancelled";
  notes: string | null;
  call_id: string | null;
  seeded: boolean;
  created_at: Date;
};

/** Keeps digits only; US numbers lose a leading country code 1. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 7 && d.length <= 15 ? d : null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
export function newCode(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Callers spell codes out loud: "k 7 q two p" â†’ "K7Q2P". */
export function normalizeCode(raw: string): string {
  const words: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  const spoken = raw.toLowerCase().replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => words[w]);
  return spoken.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

async function busyBlocks(sql: Q, now: Date, excludeId?: string): Promise<BusyBlock[]> {
  const from = DateTime.fromJSDate(now).minus({ days: 1 }).toJSDate();
  const to = DateTime.fromJSDate(now).plus({ days: CLINIC.maxDaysAhead + 2 }).toJSDate();
  const rows = await sql<{ dentist_id: string; starts_at: Date; ends_at: Date }[]>`
    select dentist_id, starts_at, ends_at from appointments
    where status = 'booked' and starts_at < ${to} and ends_at > ${from}
      and (${excludeId ?? null}::uuid is null or id <> ${excludeId ?? null}::uuid)`;
  return rows.map((r) => ({ dentistId: r.dentist_id, start: r.starts_at, end: r.ends_at }));
}

function dentistsFor(requested?: string): Dentist[] | "unknown" {
  if (!requested) return DENTISTS;
  const d = dentistById(requested);
  return d ? [d] : "unknown";
}

// â”€â”€â”€ Availability â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type AvailabilityResult =
  | { kind: "slots"; requestedDate?: string; onRequestedDay: boolean; slots: Slot[] }
  | { kind: "unknown_dentist" }
  | { kind: "bad_date" };

export async function checkAvailability(
  sql: Sql,
  args: { appointment_type: AppointmentType; date?: string; dentist_id?: string },
  now: Date,
): Promise<AvailabilityResult> {
  const dentists = dentistsFor(args.dentist_id);
  if (dentists === "unknown") return { kind: "unknown_dentist" };
  const busy = await busyBlocks(sql, now);

  if (args.date) {
    const day = parseLocalDate(args.date);
    if (!day) return { kind: "bad_date" };
    const sameDay = findSlots({ type: args.appointment_type, busy, now, fromDate: day, dentists, singleDay: true, limit: 6 });
    if (sameDay.length && sameDay[0].local.startsWith(args.date)) {
      return { kind: "slots", requestedDate: args.date, onRequestedDay: true, slots: sameDay };
    }
    const later = findSlots({ type: args.appointment_type, busy, now, fromDate: day.plus({ days: 1 }), dentists, limit: 4 });
    return { kind: "slots", requestedDate: args.date, onRequestedDay: false, slots: later };
  }
  return { kind: "slots", onRequestedDay: false, slots: findSlots({ type: args.appointment_type, busy, now, dentists, limit: 6 }) };
}

// â”€â”€â”€ Booking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type BookResult =
  | { kind: "booked"; appt: Appointment; dentist: Dentist }
  | { kind: "already_booked"; appt: Appointment; dentist: Dentist }
  | { kind: "rejected"; reason: RejectReason | "bad_phone" | "unknown_dentist" | "patient_conflict"; alternatives: Slot[] };

async function insertAppointment(
  sql: Q,
  v: { dentistId: string; name: string; phone: string; type: AppointmentType; start: Date; end: Date; notes?: string; callId?: string },
): Promise<Appointment> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await sql<Appointment[]>`
        insert into appointments (code, dentist_id, patient_name, phone, appointment_type, starts_at, ends_at, notes, call_id)
        values (${newCode()}, ${v.dentistId}, ${v.name}, ${v.phone}, ${v.type}, ${v.start}, ${v.end}, ${v.notes ?? null}, ${v.callId ?? null})
        returning *`;
      return row;
    } catch (e) {
      // A confirmation-code collision is the only unique violation possible here; draw a new code.
      if (isPgError(e, PG.uniqueViolation) && attempt < 3) continue;
      throw e;
    }
  }
}

async function alternativesNear(sql: Sql, type: AppointmentType, start: DateTime, now: Date, dentists: Dentist[]): Promise<Slot[]> {
  const busy = await busyBlocks(sql, now);
  return findSlots({ type, busy, now, fromDate: start.startOf("day"), dentists, limit: 3 });
}

export async function bookAppointment(
  sql: Sql,
  args: { patient_name: string; phone: string; appointment_type: AppointmentType; start: string; dentist_id?: string; notes?: string },
  ctx: { now: Date; callId?: string },
): Promise<BookResult> {
  const { now } = ctx;
  const phone = normalizePhone(args.phone);
  if (!phone) return { kind: "rejected", reason: "bad_phone", alternatives: [] };
  const start = parseLocal(args.start);
  if (!start) return { kind: "rejected", reason: "invalid_time", alternatives: [] };
  const dentists = dentistsFor(args.dentist_id);
  if (dentists === "unknown") return { kind: "rejected", reason: "unknown_dentist", alternatives: [] };

  const minutes = APPOINTMENT_TYPES[args.appointment_type].minutes;
  const startDate = start.toJSDate();
  const endDate = start.plus({ minutes }).toJSDate();

  // Same caller, same start time already booked â†’ the agent repeated itself. Return the existing booking.
  const [existing] = await sql<Appointment[]>`
    select * from appointments where status = 'booked' and phone = ${phone} and starts_at = ${startDate} limit 1`;
  if (existing) return { kind: "already_booked", appt: existing, dentist: dentistById(existing.dentist_id)! };

  // One person can't be in two chairs at once.
  const [clash] = await sql`
    select 1 from appointments where status = 'booked' and phone = ${phone}
      and tstzrange(starts_at, ends_at) && tstzrange(${startDate}::timestamptz, ${endDate}::timestamptz) limit 1`;
  if (clash) return { kind: "rejected", reason: "patient_conflict", alternatives: await alternativesNear(sql, args.appointment_type, start, now, dentists) };

  const busy = await busyBlocks(sql, now);
  let lastReason: RejectReason = "busy";
  for (const d of dentists) {
    const why = checkFit(start, args.appointment_type, d, busy, now);
    if (why) {
      lastReason = why;
      continue;
    }
    try {
      const appt = await insertAppointment(sql, {
        dentistId: d.id, name: args.patient_name.trim(), phone, type: args.appointment_type,
        start: startDate, end: endDate, notes: args.notes, callId: ctx.callId,
      });
      return { kind: "booked", appt, dentist: d };
    } catch (e) {
      // Someone else took this chair between our check and our insert. Try the next dentist.
      if (isPgError(e, PG.exclusionViolation)) {
        lastReason = "busy";
        continue;
      }
      throw e;
    }
  }
  return { kind: "rejected", reason: lastReason, alternatives: await alternativesNear(sql, args.appointment_type, start, now, dentists) };
}

// â”€â”€â”€ Lookup / cancel / reschedule â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function findAppointments(sql: Sql, rawPhone: string, now: Date): Promise<Appointment[] | "bad_phone"> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return "bad_phone";
  return sql<Appointment[]>`
    select * from appointments where status = 'booked' and phone = ${phone} and starts_at > ${now}
    order by starts_at limit 5`;
}

export type CancelResult = { kind: "cancelled"; appt: Appointment } | { kind: "not_found" } | { kind: "bad_phone" };

export async function cancelAppointment(sql: Sql, args: { confirmation_code: string; phone: string }, now: Date): Promise<CancelResult> {
  const phone = normalizePhone(args.phone);
  if (!phone) return { kind: "bad_phone" };
  // Code AND phone must match, so nobody can cancel someone else's visit by guessing a code.
  const [appt] = await sql<Appointment[]>`
    update appointments set status = 'cancelled', updated_at = now()
    where code = ${normalizeCode(args.confirmation_code)} and phone = ${phone} and status = 'booked' and starts_at > ${now}
    returning *`;
  return appt ? { kind: "cancelled", appt } : { kind: "not_found" };
}

export type RescheduleResult =
  | { kind: "rescheduled"; from: Appointment; to: Appointment; dentist: Dentist }
  | { kind: "not_found" }
  | { kind: "bad_phone" }
  | { kind: "rejected"; reason: RejectReason; alternatives: Slot[] };

class SlotTaken extends Error {}

export async function rescheduleAppointment(
  sql: Sql,
  args: { confirmation_code: string; phone: string; new_start: string; dentist_id?: string },
  ctx: { now: Date; callId?: string },
): Promise<RescheduleResult> {
  const { now } = ctx;
  const phone = normalizePhone(args.phone);
  if (!phone) return { kind: "bad_phone" };
  const start = parseLocal(args.new_start);
  if (!start) return { kind: "rejected", reason: "invalid_time", alternatives: [] };

  let apptType: AppointmentType = "checkup";
  try {
    return await sql.begin(async (tx) => {
      const [old] = await tx<Appointment[]>`
        select * from appointments
        where code = ${normalizeCode(args.confirmation_code)} and phone = ${phone} and status = 'booked' and starts_at > ${now}
        for update`;
      if (!old) return { kind: "not_found" } as const;

      const type = old.appointment_type;
      apptType = type;
      const dentists = dentistsFor(args.dentist_id ?? old.dentist_id);
      const pool = dentists === "unknown" ? DENTISTS : dentists;
      const busy = await busyBlocks(tx, now, old.id); // the old slot doesn't block its own move
      const fit = pool.find((d) => checkFit(start, type, d, busy, now) === null);
      if (!fit) {
        const reason = checkFit(start, type, pool[0], busy, now) ?? "busy";
        return { kind: "rejected", reason, alternatives: findSlots({ type, busy, now, fromDate: start.startOf("day"), dentists: pool, limit: 3 }) } as const;
      }

      await tx`update appointments set status = 'cancelled', updated_at = now() where id = ${old.id}`;
      try {
        const to = await insertAppointment(tx, {
          dentistId: fit.id, name: old.patient_name, phone, type,
          start: start.toJSDate(), end: start.plus({ minutes: APPOINTMENT_TYPES[type].minutes }).toJSDate(),
          notes: old.notes ?? undefined, callId: ctx.callId,
        });
        return { kind: "rescheduled", from: old, to, dentist: fit } as const;
      } catch (e) {
        if (isPgError(e, PG.exclusionViolation)) throw new SlotTaken(); // rolls back the cancel too
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof SlotTaken) {
      const busy = await busyBlocks(sql, now);
      return { kind: "rejected", reason: "busy", alternatives: findSlots({ type: apptType, busy, now, fromDate: start.startOf("day"), limit: 3 }) };
    }
    throw e;
  }
}

// â”€â”€â”€ Staff hand-off â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function flagForStaff(
  sql: Sql,
  args: { urgency: "emergency" | "callback"; reason: string; patient_name?: string; phone?: string },
  callId?: string,
): Promise<{ id: string }> {
  const phone = args.phone ? normalizePhone(args.phone) : null;
  const [row] = await sql<{ id: string }[]>`
    insert into staff_tasks (call_id, urgency, reason, patient_name, phone)
    values (${callId ?? null}, ${args.urgency}, ${args.reason}, ${args.patient_name ?? null}, ${phone})
    returning id`;
  return row;
}
