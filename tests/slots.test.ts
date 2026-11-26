import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { DENTISTS } from "@/lib/clinic";
import { normalizeCode, normalizePhone } from "@/lib/booking";
import { checkFit, findSlots, openSlotsOnDay, parseLocal, todayLine } from "@/lib/slots";
import { maskName, maskPhone, maskTranscript } from "@/lib/state";

const tz = "America/New_York";
const local = (s: string) => DateTime.fromISO(s, { zone: tz });
// Monday 30 Nov 2026, 08:00 in New York.
const NOW = local("2026-11-30T08:00").toJSDate();
const [patel, morgan] = DENTISTS;

describe("clinic rules", () => {
  it("accepts a normal weekday slot", () => {
    expect(checkFit(local("2026-11-30T09:00"), "checkup", patel, [], NOW)).toBeNull();
  });

  it("requires at least an hour's notice", () => {
    expect(checkFit(local("2026-11-30T08:30"), "checkup", patel, [], NOW)).toBe("too_soon");
  });

  it("blocks the lunch break, including long visits that run into it", () => {
    expect(checkFit(local("2026-11-30T12:00"), "checkup", patel, [], NOW)).toBe("closed");
    expect(checkFit(local("2026-11-30T11:30"), "cleaning", patel, [], NOW)).toBe("closed");
    expect(checkFit(local("2026-11-30T11:00"), "cleaning", patel, [], NOW)).toBeNull();
  });

  it("won't let a visit run past closing", () => {
    expect(checkFit(local("2026-11-30T16:30"), "cleaning", patel, [], NOW)).toBe("closed");
    expect(checkFit(local("2026-11-30T16:00"), "cleaning", patel, [], NOW)).toBeNull();
    expect(checkFit(local("2026-11-30T16:30"), "checkup", patel, [], NOW)).toBeNull();
  });

  it("knows Saturdays and Sundays", () => {
    expect(checkFit(local("2026-12-05T10:00"), "checkup", patel, [], NOW)).toBeNull();
    expect(checkFit(local("2026-12-05T10:00"), "checkup", morgan, [], NOW)).toBe("dentist_not_working");
    expect(checkFit(local("2026-12-05T13:00"), "checkup", patel, [], NOW)).toBe("closed");
    expect(checkFit(local("2026-12-06T10:00"), "checkup", patel, [], NOW)).toBe("closed");
  });

  it("keeps to the half-hour grid and the 30-day window", () => {
    expect(checkFit(local("2026-11-30T09:15"), "checkup", patel, [], NOW)).toBe("not_on_grid");
    expect(checkFit(local("2027-01-04T09:00"), "checkup", patel, [], NOW)).toBe("too_far");
  });

  it("respects existing bookings for that dentist only", () => {
    const busy = [{ dentistId: patel.id, start: local("2026-11-30T09:00").toJSDate(), end: local("2026-11-30T10:00").toJSDate() }];
    expect(checkFit(local("2026-11-30T09:30"), "checkup", patel, busy, NOW)).toBe("busy");
    expect(checkFit(local("2026-11-30T09:30"), "checkup", morgan, busy, NOW)).toBeNull();
    expect(checkFit(local("2026-11-30T10:00"), "checkup", patel, busy, NOW)).toBeNull();
  });
});

describe("slot search", () => {
  it("offers distinct times, earliest first", () => {
    const slots = findSlots({ type: "checkup", busy: [], now: NOW, limit: 4 });
    expect(slots.map((s) => s.local)).toEqual(["2026-11-30T09:00", "2026-11-30T09:30", "2026-11-30T10:00", "2026-11-30T10:30"]);
  });

  it("skips a fully booked day and moves on", () => {
    const day = local("2026-11-30");
    const busy = DENTISTS.map((d) => ({ dentistId: d.id, start: day.set({ hour: 9 }).toJSDate(), end: day.set({ hour: 17 }).toJSDate() }));
    const slots = findSlots({ type: "checkup", busy, now: NOW, limit: 1 });
    expect(slots[0].local).toBe("2026-12-01T09:00");
  });

  it("has no Sunday slots", () => {
    expect(openSlotsOnDay(local("2026-12-06"), "checkup", [], NOW)).toEqual([]);
  });

  it("uses real UTC instants across the daylight-saving change", () => {
    // 9 AM in New York is 14:00 UTC in winter and 13:00 UTC after 14 March 2027.
    const later = local("2027-03-12T08:00").toJSDate();
    const fri = findSlots({ type: "checkup", busy: [], now: later, limit: 1 })[0];
    expect(fri.start.toISOString()).toBe("2027-03-12T14:00:00.000Z");
    const mon = findSlots({ type: "checkup", busy: [], now: later, fromDate: local("2027-03-15"), limit: 1 })[0];
    expect(mon.start.toISOString()).toBe("2027-03-15T13:00:00.000Z");
  });

  it("rejects wall-clock times that don't exist", () => {
    expect(parseLocal("2027-03-14T02:30")).toBeNull();
    expect(parseLocal("not a date")).toBeNull();
    expect(parseLocal("2026-11-30T09:00")?.toISO()).toContain("2026-11-30T09:00");
  });

  it("tells the agent today's date in clinic time", () => {
    expect(todayLine(NOW)).toContain("Monday, November 30, 2026");
  });
});

describe("normalising what callers say", () => {
  it("normalises US phone numbers", () => {
    expect(normalizePhone("+1 (415) 555-0100")).toBe("4155550100");
    expect(normalizePhone("415 555 0100")).toBe("4155550100");
    expect(normalizePhone("12")).toBeNull();
  });

  it("reads spoken confirmation codes", () => {
    expect(normalizeCode("k 7 q two p")).toBe("K7Q2P");
    expect(normalizeCode("K-7-Q-2-P")).toBe("K7Q2P");
  });

  it("masks personal details for the public dashboard", () => {
    expect(maskName("Maria Gonzalez")).toBe("Maria G.");
    expect(maskPhone("4155550100")).toBe("•••• ••00");
    expect(maskTranscript("my number is 415 555 0100 thanks")).toBe("my number is [phone number] thanks");
    expect(maskTranscript("at 10:30 on the 2nd")).toBe("at 10:30 on the 2nd");
  });
});
