"use client";

import { useEffect, useState } from "react";
import type { DashboardState } from "@/lib/state";

const TZ = "America/New_York";
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

const OUTCOME_STYLE: Record<string, string> = {
  booked: "bg-success-soft text-success",
  rescheduled: "bg-primary-soft text-primary",
  cancelled: "bg-background text-muted",
  flagged: "bg-danger-soft text-danger",
};

export function Dashboard({ fast, refreshKey }: { fast: boolean; refreshKey: number }) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [failed, setFailed] = useState(false);
  const [openCall, setOpenCall] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as DashboardState;
        if (!cancelled) {
          setState(json);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, fast ? 2000 : 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fast, refreshKey]);

  const now = state ? new Date(state.now).getTime() : 0;
  const byDay = new Map<string, DashboardState["appointments"]>();
  for (const a of state?.appointments ?? []) {
    const key = dayFmt.format(new Date(a.startsAt));
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Clinic schedule</h2>
            <p className="text-sm text-muted">Next 7 days · Eastern time · live from the database</p>
          </div>
          <span className="flex items-center gap-2 text-xs text-muted">
            <span className={`size-2 rounded-full ${failed ? "bg-danger" : "bg-success"} ${fast ? "animate-pulse" : ""}`} />
            {failed ? "Reconnecting" : fast ? "Live" : "Synced"}
          </span>
        </div>
        <div className="max-h-[26rem] overflow-y-auto px-6 py-4">
          {!state ? (
            <p className="py-8 text-center text-sm text-muted">{failed ? "Can't reach the schedule right now." : "Loading schedule…"}</p>
          ) : byDay.size === 0 ? (
            <p className="py-8 text-center text-sm text-muted">No appointments this week.</p>
          ) : (
            [...byDay.entries()].map(([day, items]) => (
              <div key={day} className="mb-5 last:mb-0">
                <h3 className="mb-2 text-sm font-semibold">{day}</h3>
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {items.map((a) => {
                    const fresh = a.fromCall && now - new Date(a.createdAt).getTime() < 5 * 60_000;
                    return (
                      <li key={a.id} className={`flex items-center gap-4 px-4 py-2.5 text-[15px] ${fresh ? "flash-in" : ""}`}>
                        <span className="w-20 shrink-0 font-mono text-sm tabular-nums text-muted">{timeFmt.format(new Date(a.startsAt))}</span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{a.patient}</span>
                          <span className="text-muted"> · {a.type}</span>
                        </span>
                        <span className="hidden shrink-0 text-sm text-muted sm:inline">{a.dentist}</span>
                        {a.fromCall && (
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${fresh ? "bg-success-soft text-success" : "bg-primary-soft text-primary"}`}>
                            {fresh ? "just booked" : "by phone"}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">Staff alerts</h2>
          <p className="text-sm text-muted">Hand-offs from the receptionist</p>
          <ul className="mt-4 space-y-3">
            {(state?.tasks ?? []).length === 0 && <li className="text-sm text-muted">Nothing waiting.</li>}
            {state?.tasks.map((t) => (
              <li key={t.id} className="rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.urgency === "emergency" ? "bg-danger-soft text-danger" : "bg-primary-soft text-primary"}`}>
                    {t.urgency === "emergency" ? "Urgent" : "Callback"}
                  </span>
                  <span className="text-xs text-muted">{ago(t.createdAt, now)}</span>
                </div>
                <p className="mt-2 text-[15px] leading-relaxed">{t.reason}</p>
                {(t.patient || t.phone) && <p className="mt-1 text-sm text-muted">{[t.patient, t.phone].filter(Boolean).join(" · ")}</p>}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">Recent calls</h2>
          <p className="text-sm text-muted">Logged when each call ends</p>
          <ul className="mt-4 space-y-3">
            {(state?.calls ?? []).length === 0 && <li className="text-sm text-muted">No calls yet. Be the first.</li>}
            {state?.calls.map((c) => (
              <li key={c.callId} className="rounded-xl border border-border p-3">
                <button type="button" className="w-full text-left" onClick={() => setOpenCall(openCall === c.callId ? null : c.callId)}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      {c.outcomes.length === 0 ? (
                        <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted">question only</span>
                      ) : (
                        c.outcomes.map((o) => (
                          <span key={o} className={`rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_STYLE[o] ?? ""}`}>{o}</span>
                        ))
                      )}
                    </div>
                    <span className="text-xs text-muted">{c.endedAt ? ago(c.endedAt, now) : ""}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted">
                    {c.durationSec != null ? `${Math.floor(c.durationSec / 60)}m ${c.durationSec % 60}s` : "-"}
                    {c.costUsd != null ? ` · $${c.costUsd.toFixed(2)}` : ""} · {openCall === c.callId ? "hide" : "show"} transcript
                  </p>
                </button>
                {openCall === c.callId && c.transcript && (
                  <pre className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-3 font-sans text-sm leading-relaxed">{c.transcript}</pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
