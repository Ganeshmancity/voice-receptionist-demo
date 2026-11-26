// The receptionist's tools: input validation, replay-safe execution, and the
// exact sentence returned to the voice agent for each outcome.
import { z } from "zod";
import { APPOINTMENT_TYPES, APPOINTMENT_TYPE_KEYS, CLINIC, DENTISTS, HOURS, dentistById, type AppointmentType } from "./clinic";
import {
  bookAppointment,
  cancelAppointment,
  checkAvailability,
  findAppointments,
  flagForStaff,
  rescheduleAppointment,
  type Appointment,
} from "./booking";
import type { Sql } from "./db";
import { parseLocalDate, spoken, todayLine, type RejectReason, type Slot } from "./slots";

const apptType = z.enum(APPOINTMENT_TYPE_KEYS as [AppointmentType, ...AppointmentType[]]);
const dentistId = z.enum(DENTISTS.map((d) => d.id) as [string, ...string[]]);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "use YYYY-MM-DDTHH:mm in clinic time");

export const schemas = {
  check_availability: z.object({
    appointment_type: apptType,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional(),
    dentist_id: dentistId.optional(),
  }),
  book_appointment: z.object({
    patient_name: z.string().trim().min(2).max(80),
    phone: z.string().min(7).max(25),
    appointment_type: apptType,
    start: localDateTime,
    dentist_id: dentistId.optional(),
    notes: z.string().max(300).optional(),
  }),
  find_appointments: z.object({ phone: z.string().min(7).max(25) }),
  cancel_appointment: z.object({ confirmation_code: z.string().min(3).max(20), phone: z.string().min(7).max(25) }),
  reschedule_appointment: z.object({
    confirmation_code: z.string().min(3).max(20),
    phone: z.string().min(7).max(25),
    new_start: localDateTime,
    dentist_id: dentistId.optional(),
  }),
  flag_for_staff: z.object({
    urgency: z.enum(["emergency", "callback"]),
    reason: z.string().trim().min(3).max(400),
    patient_name: z.string().max(80).optional(),
    phone: z.string().max(25).optional(),
  }),
} as const;

export type ToolName = keyof typeof schemas;
export const TOOL_NAMES = Object.keys(schemas) as ToolName[];

/** JSON-schema parameter definitions sent to Vapi when the assistant is created. */
export const toolDefinitions: { name: ToolName; description: string; parameters: Record<string, unknown> }[] = [
  {
    name: "check_availability",
    description:
      "Find open appointment times. Call this before offering any time, and again whenever the caller asks about a different day. The result also states today's date and time.",
    parameters: {
      type: "object",
      properties: {
        appointment_type: { type: "string", enum: APPOINTMENT_TYPE_KEYS, description: "checkup (30 min), cleaning (60 min), emergency (tooth pain, broken tooth; 30 min), consultation (whitening, implants, braces; 30 min)" },
        date: { type: "string", description: "Day the caller wants, YYYY-MM-DD in clinic time. Omit for the earliest openings." },
        dentist_id: { type: "string", enum: DENTISTS.map((d) => d.id), description: "Only if the caller asks for a specific dentist." },
      },
      required: ["appointment_type"],
    },
  },
  {
    name: "book_appointment",
    description: "Book a time the caller chose from check_availability. Only call after confirming name, phone number, type and time with the caller.",
    parameters: {
      type: "object",
      properties: {
        patient_name: { type: "string", description: "Caller's full name" },
        phone: { type: "string", description: "Callback phone number, digits" },
        appointment_type: { type: "string", enum: APPOINTMENT_TYPE_KEYS },
        start: { type: "string", description: "Exact start value from check_availability, YYYY-MM-DDTHH:mm" },
        dentist_id: { type: "string", enum: DENTISTS.map((d) => d.id) },
        notes: { type: "string", description: "Short reason for the visit, e.g. 'sensitive lower left molar'" },
      },
      required: ["patient_name", "phone", "appointment_type", "start"],
    },
  },
  {
    name: "find_appointments",
    description: "Look up the caller's upcoming appointments by phone number.",
    parameters: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"] },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an appointment. Needs the confirmation code and the phone number it was booked with. Confirm with the caller first.",
    parameters: {
      type: "object",
      properties: { confirmation_code: { type: "string" }, phone: { type: "string" } },
      required: ["confirmation_code", "phone"],
    },
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing appointment to a new open time (from check_availability). The old time is released only if the new one is secured.",
    parameters: {
      type: "object",
      properties: {
        confirmation_code: { type: "string" },
        phone: { type: "string" },
        new_start: { type: "string", description: "YYYY-MM-DDTHH:mm from check_availability" },
        dentist_id: { type: "string", enum: DENTISTS.map((d) => d.id) },
      },
      required: ["confirmation_code", "phone", "new_start"],
    },
  },
  {
    name: "flag_for_staff",
    description:
      "Hand off to a human. urgency=emergency for severe pain, swelling, a knocked-out tooth or bleeding that won't stop (also offer the earliest emergency slot). urgency=callback for billing, insurance, complaints, or anything you can't handle.",
    parameters: {
      type: "object",
      properties: {
        urgency: { type: "string", enum: ["emergency", "callback"] },
        reason: { type: "string", description: "One or two sentences a staff member can act on" },
        patient_name: { type: "string" },
        phone: { type: "string" },
      },
      required: ["urgency", "reason"],
    },
  },
];

// ─── Result wording ────────────────────────────────────────────────────────────

const typeLabel = (t: AppointmentType) => APPOINTMENT_TYPES[t].label;
const dentistName = (id: string) => dentistById(id)?.name ?? id;
const spell = (code: string) => code.split("").join("-");

function slotLines(slots: Slot[]): string {
  return slots.map((s) => `- ${spoken(s.start)} with ${s.dentistName} (start=${s.local}, dentist_id=${s.dentistId})`).join("\n");
}

const REJECT_TEXT: Record<RejectReason | "bad_phone" | "unknown_dentist" | "patient_conflict", string> = {
  invalid_time: "That time isn't valid. Use a start value from check_availability.",
  not_on_grid: "Appointments start on the hour or half hour.",
  closed: `The clinic is closed then. Hours: Monday to Friday 9 AM to 5 PM (lunch 12 to 1), Saturday 9 AM to 1 PM, closed Sunday.`,
  too_soon: `That's too soon — appointments need at least ${CLINIC.minLeadMinutes} minutes' notice.`,
  too_far: `We only book up to ${CLINIC.maxDaysAhead} days ahead.`,
  dentist_not_working: "That dentist doesn't work that day.",
  busy: "That time was just taken.",
  bad_phone: "The phone number doesn't look complete. Ask the caller to repeat it.",
  unknown_dentist: `Unknown dentist. Our dentists are ${DENTISTS.map((d) => `${d.name} (${d.id})`).join(" and ")}.`,
  patient_conflict: "This caller already has an appointment overlapping that time.",
};

function apptLine(a: Appointment): string {
  return `${typeLabel(a.appointment_type)} with ${dentistName(a.dentist_id)} on ${spoken(a.starts_at)}, confirmation code ${spell(a.code)}`;
}

export type Outcome = "booked" | "rescheduled" | "cancelled" | "flagged" | "info" | "rejected";

async function execute(sql: Sql, name: ToolName, input: unknown, ctx: { now: Date; callId?: string }): Promise<{ text: string; outcome: Outcome }> {
  const { now, callId } = ctx;
  switch (name) {
    case "check_availability": {
      const a = schemas.check_availability.parse(input);
      const r = await checkAvailability(sql, a, now);
      const head = todayLine(now);
      if (r.kind === "unknown_dentist") return { text: `${head}\n${REJECT_TEXT.unknown_dentist}`, outcome: "info" };
      if (r.kind === "bad_date") return { text: `${head}\nThe date must be YYYY-MM-DD.`, outcome: "info" };
      if (!r.slots.length) return { text: `${head}\nNo openings for a ${typeLabel(a.appointment_type)} in the next ${CLINIC.maxDaysAhead} days. Offer a staff callback.`, outcome: "info" };
      if (r.requestedDate && !r.onRequestedDay) {
        const day = parseLocalDate(r.requestedDate);
        const why = day && !HOURS[day.weekday] ? "the clinic is closed that day" : "that day is fully booked or already past";
        return { text: `${head}\nNo ${typeLabel(a.appointment_type)} openings on ${r.requestedDate}: ${why}. Nearest openings:\n${slotLines(r.slots)}\nOffer two or three of these.`, outcome: "info" };
      }
      return { text: `${head}\nOpen times for a ${typeLabel(a.appointment_type)}:\n${slotLines(r.slots)}\nOffer two or three of these. To book, pass the exact start value.`, outcome: "info" };
    }
    case "book_appointment": {
      const a = schemas.book_appointment.parse(input);
      const r = await bookAppointment(sql, a, { now, callId });
      if (r.kind === "booked") return { text: `BOOKED: ${apptLine(r.appt)}. Read the day, time and code back to the caller, spelling the code.`, outcome: "booked" };
      if (r.kind === "already_booked") return { text: `ALREADY BOOKED (no new booking made): ${apptLine(r.appt)}.`, outcome: "info" };
      const alt = r.alternatives.length ? `\nClosest open times:\n${slotLines(r.alternatives)}` : "";
      return { text: `NOT BOOKED. ${REJECT_TEXT[r.reason]}${alt}`, outcome: "rejected" };
    }
    case "find_appointments": {
      const a = schemas.find_appointments.parse(input);
      const r = await findAppointments(sql, a.phone, now);
      if (r === "bad_phone") return { text: REJECT_TEXT.bad_phone, outcome: "info" };
      if (!r.length) return { text: "No upcoming appointments for that phone number.", outcome: "info" };
      return { text: `Upcoming appointments:\n${r.map((x) => `- ${apptLine(x)}`).join("\n")}`, outcome: "info" };
    }
    case "cancel_appointment": {
      const a = schemas.cancel_appointment.parse(input);
      const r = await cancelAppointment(sql, a, now);
      if (r.kind === "bad_phone") return { text: REJECT_TEXT.bad_phone, outcome: "rejected" };
      if (r.kind === "not_found") return { text: "No upcoming appointment matches that code and phone number. Ask the caller to check the code, or look it up with find_appointments.", outcome: "rejected" };
      return { text: `CANCELLED: ${apptLine(r.appt)}.`, outcome: "cancelled" };
    }
    case "reschedule_appointment": {
      const a = schemas.reschedule_appointment.parse(input);
      const r = await rescheduleAppointment(sql, a, { now, callId });
      if (r.kind === "bad_phone") return { text: REJECT_TEXT.bad_phone, outcome: "rejected" };
      if (r.kind === "not_found") return { text: "No upcoming appointment matches that code and phone number.", outcome: "rejected" };
      if (r.kind === "rejected") {
        const alt = r.alternatives.length ? `\nClosest open times:\n${slotLines(r.alternatives)}` : "";
        return { text: `NOT MOVED (the original appointment is unchanged). ${REJECT_TEXT[r.reason]}${alt}`, outcome: "rejected" };
      }
      return { text: `RESCHEDULED: was ${spoken(r.from.starts_at)}; now ${apptLine(r.to)}. The code has changed — read the new one back.`, outcome: "rescheduled" };
    }
    case "flag_for_staff": {
      const a = schemas.flag_for_staff.parse(input);
      await flagForStaff(sql, a, callId);
      return {
        text: a.urgency === "emergency"
          ? "Flagged as URGENT for the on-call team. Tell the caller a staff member will call them back within 15 minutes, and offer the earliest emergency slot."
          : "Callback request logged. Tell the caller the front desk will call back within one business day.",
        outcome: "flagged",
      };
    }
  }
}

// ─── Replay-safe runner ────────────────────────────────────────────────────────

export type ToolCallInput = { id: string; name: string; arguments: unknown; callId?: string };
export type ToolCallOutput = { toolCallId: string; result: string } | { toolCallId: string; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one Vapi tool call at most once per toolCallId. A retried or duplicated
 * webhook gets the stored result back instead of booking a second time.
 */
export async function runToolCall(sql: Sql, call: ToolCallInput, now: Date): Promise<ToolCallOutput> {
  const toolCallId = call.id;
  if (!(TOOL_NAMES as string[]).includes(call.name)) return { toolCallId, error: `Unknown tool ${call.name}` };
  const name = call.name as ToolName;

  let args: unknown = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { toolCallId, result: "The tool arguments were not valid JSON. Try again." };
    }
  }

  const parsed = schemas[name].safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { toolCallId, result: `Missing or invalid details (${issues}). Ask the caller for them, then try again.` };
  }

  const claimed = await sql`
    insert into tool_calls (tool_call_id, call_id, name, arguments)
    values (${toolCallId}, ${call.callId ?? null}, ${name}, ${sql.json(parsed.data as never)})
    on conflict (tool_call_id) do nothing
    returning tool_call_id`;

  if (!claimed.length) {
    // Duplicate delivery. Wait briefly for the first run to finish, then replay its answer.
    for (let i = 0; i < 20; i++) {
      const [row] = await sql<{ result: string | null }[]>`select result from tool_calls where tool_call_id = ${toolCallId}`;
      if (row?.result != null) return { toolCallId, result: row.result };
      await sleep(250);
    }
    return { toolCallId, error: "Still working on the previous request." };
  }

  try {
    const { text, outcome } = await execute(sql, name, parsed.data, { now, callId: call.callId });
    await sql`update tool_calls set result = ${text}, outcome = ${outcome} where tool_call_id = ${toolCallId}`;
    return { toolCallId, result: text };
  } catch (e) {
    console.error(`[tool] ${name} failed`, e);
    // Release the claim so a retry can run it again.
    await sql`delete from tool_calls where tool_call_id = ${toolCallId}`.catch(() => {});
    return { toolCallId, error: "The booking system had a problem. Apologise and offer to take a message for a staff callback." };
  }
}
