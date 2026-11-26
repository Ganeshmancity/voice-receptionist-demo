// Demo clinic configuration. The clinic is fictional.

export const CLINIC = {
  name: "Northgate Family Dental",
  timezone: "America/New_York",
  slotMinutes: 30,
  /** Earliest bookable start, measured from "now". */
  minLeadMinutes: 60,
  /** Extra margin on times we OFFER, so an offered time is still bookable when the caller says yes. */
  offerBufferMinutes: 10,
  /** How far ahead callers can book. */
  maxDaysAhead: 30,
  address: "1200 Northgate Ave, Suite 4 (demo address)",
} as const;

/** Opening hours per ISO weekday (1 = Monday … 7 = Sunday), clinic-local "HH:mm". */
export const HOURS: Record<number, { open: string; close: string; breaks?: [string, string][] } | null> = {
  1: { open: "09:00", close: "17:00", breaks: [["12:00", "13:00"]] },
  2: { open: "09:00", close: "17:00", breaks: [["12:00", "13:00"]] },
  3: { open: "09:00", close: "17:00", breaks: [["12:00", "13:00"]] },
  4: { open: "09:00", close: "17:00", breaks: [["12:00", "13:00"]] },
  5: { open: "09:00", close: "17:00", breaks: [["12:00", "13:00"]] },
  6: { open: "09:00", close: "13:00" },
  7: null,
};

export type Dentist = { id: string; name: string; weekdays: number[] };

export const DENTISTS: Dentist[] = [
  { id: "dr-patel", name: "Dr. Anika Patel", weekdays: [1, 2, 3, 4, 5, 6] },
  { id: "dr-morgan", name: "Dr. Sam Morgan", weekdays: [1, 2, 3, 4, 5] },
];

export const APPOINTMENT_TYPES = {
  checkup: { label: "Check-up", minutes: 30 },
  cleaning: { label: "Cleaning", minutes: 60 },
  emergency: { label: "Emergency / tooth pain", minutes: 30 },
  consultation: { label: "Consultation (whitening, implants, braces)", minutes: 30 },
} as const;

export type AppointmentType = keyof typeof APPOINTMENT_TYPES;

export const APPOINTMENT_TYPE_KEYS = Object.keys(APPOINTMENT_TYPES) as AppointmentType[];

export function dentistById(id: string): Dentist | undefined {
  return DENTISTS.find((d) => d.id === id);
}
