// Pure slot logic: no database, no clock of its own (callers pass `now`),
// so every rule here is unit-tested deterministically.
import { DateTime, Interval } from "luxon";
import {
  APPOINTMENT_TYPES,
  CLINIC,
  DENTISTS,
  HOURS,
  type AppointmentType,
  type Dentist,
} from "./clinic";

export type BusyBlock = { dentistId: string; start: Date; end: Date };

export type Slot = {
  dentistId: string;
  dentistName: string;
  /** Clinic-local wall time, "YYYY-MM-DDTHH:mm" — what the voice agent passes back to book. */
  local: string;
  start: Date;
  end: Date;
};

const tz = CLINIC.timezone;

/** Parse "YYYY-MM-DDTHH:mm" (or with seconds) as clinic-local time. Returns null if invalid. */
export function parseLocal(local: string): DateTime | null {
  const dt = DateTime.fromISO(local, { zone: tz });
  if (!dt.isValid) return null;
  // Reject wall times that don't exist (DST spring-forward gap): Luxon shifts them silently.
  const roundTrip = dt.toFormat("yyyy-MM-dd'T'HH:mm");
  if (!local.startsWith(roundTrip)) return null;
  return dt;
}

export function parseLocalDate(date: string): DateTime | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dt = DateTime.fromISO(date, { zone: tz }).startOf("day");
  return dt.isValid ? dt : null;
}

export function toLocalString(d: Date): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm");
}

/** "Thursday, November 27 at 10:30 AM" — the phrasing the agent reads aloud. */
export function spoken(d: Date): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat("cccc, LLLL d 'at' h:mm a");
}

export function todayLine(now: Date): string {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  return `Today is ${dt.toFormat("cccc, LLLL d, yyyy")} and the time is ${dt.toFormat("h:mm a")} (clinic time, ${dt.toFormat("ZZZZ")}).`;
}

function at(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

export type RejectReason =
  | "invalid_time"
  | "not_on_grid"
  | "closed"
  | "too_soon"
  | "too_far"
  | "dentist_not_working"
  | "busy";

/**
 * Checks whether one dentist can take an appointment at `start`.
 * Returns null when it fits, otherwise the reason.
 */
export function checkFit(
  start: DateTime,
  type: AppointmentType,
  dentist: Dentist,
  busy: BusyBlock[],
  now: Date,
): RejectReason | null {
  if (!start.isValid) return "invalid_time";
  if (start.minute % CLINIC.slotMinutes !== 0 || start.second !== 0) return "not_on_grid";

  const nowDt = DateTime.fromJSDate(now, { zone: tz });
  if (start < nowDt.plus({ minutes: CLINIC.minLeadMinutes })) return "too_soon";
  if (start > nowDt.plus({ days: CLINIC.maxDaysAhead })) return "too_far";

  const hours = HOURS[start.weekday];
  if (!hours) return "closed";
  if (!dentist.weekdays.includes(start.weekday)) return "dentist_not_working";

  const day = start.startOf("day");
  const end = start.plus({ minutes: APPOINTMENT_TYPES[type].minutes });
  const open = at(day, hours.open);
  const close = at(day, hours.close);
  if (start < open || end > close) return "closed";

  const appt = Interval.fromDateTimes(start, end);
  for (const [b0, b1] of hours.breaks ?? []) {
    if (appt.overlaps(Interval.fromDateTimes(at(day, b0), at(day, b1)))) return "closed";
  }

  for (const b of busy) {
    if (b.dentistId !== dentist.id) continue;
    const blk = Interval.fromDateTimes(
      DateTime.fromJSDate(b.start, { zone: tz }),
      DateTime.fromJSDate(b.end, { zone: tz }),
    );
    if (appt.overlaps(blk)) return "busy";
  }
  return null;
}

/** All open slots on one clinic-local day, earliest first, across the given dentists. */
export function openSlotsOnDay(
  day: DateTime,
  type: AppointmentType,
  busy: BusyBlock[],
  now: Date,
  dentists: Dentist[] = DENTISTS,
): Slot[] {
  const hours = HOURS[day.weekday];
  if (!hours) return [];
  const minutes = APPOINTMENT_TYPES[type].minutes;
  const out: Slot[] = [];
  for (let t = at(day, hours.open); t < at(day, hours.close); t = t.plus({ minutes: CLINIC.slotMinutes })) {
    for (const d of dentists) {
      if (checkFit(t, type, d, busy, now) === null) {
        out.push({
          dentistId: d.id,
          dentistName: d.name,
          local: t.toFormat("yyyy-MM-dd'T'HH:mm"),
          start: t.toJSDate(),
          end: t.plus({ minutes }).toJSDate(),
        });
      }
    }
  }
  return out;
}

/**
 * Finds open slots starting on `fromDate` (clinic-local) and moving forward day by day
 * until `limit` distinct start times are found or the booking window ends.
 * One entry per start time (first free dentist), so the agent can offer clean choices.
 */
export function findSlots(opts: {
  type: AppointmentType;
  busy: BusyBlock[];
  now: Date;
  fromDate?: DateTime;
  dentists?: Dentist[];
  limit?: number;
  /** Only search this one day. */
  singleDay?: boolean;
}): Slot[] {
  const { type, busy, now, dentists = DENTISTS, limit = 6, singleDay = false } = opts;
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  let day = opts.fromDate && opts.fromDate > today ? opts.fromDate.startOf("day") : today;
  const lastDay = today.plus({ days: CLINIC.maxDaysAhead });

  const out: Slot[] = [];
  const seen = new Set<string>();
  while (day <= lastDay && out.length < limit) {
    for (const s of openSlotsOnDay(day, type, busy, now, dentists)) {
      if (seen.has(s.local)) continue;
      seen.add(s.local);
      out.push(s);
      if (out.length >= limit) break;
    }
    if (singleDay) break;
    day = day.plus({ days: 1 });
  }
  return out;
}
