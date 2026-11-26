"use client";

import type Vapi from "@vapi-ai/web";
import { useEffect, useRef, useState } from "react";
import { todayLine } from "@/lib/slots";

type Line = { id: number; role: "assistant" | "user"; text: string; final: boolean };
type Status = "idle" | "connecting" | "live" | "ended" | "error";

const TOOL_LABELS: Record<string, string> = {
  check_availability: "Checking the schedule",
  book_appointment: "Booking the appointment",
  find_appointments: "Looking up appointments",
  cancel_appointment: "Cancelling",
  reschedule_appointment: "Rescheduling",
  flag_for_staff: "Alerting staff",
};

const TRY_SAYING = [
  "I'd like a cleaning next Tuesday morning.",
  "I have bad tooth pain, can someone see me today?",
  "Can I move my appointment? My code is …",
  "Do you take Delta Dental insurance?",
];

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
const ASSISTANT_ID = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;

export function CallPanel({ onActiveChange, onToolResult }: { onActiveChange: (active: boolean) => void; onToolResult: () => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [activity, setActivity] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vapiRef = useRef<Vapi | null>(null);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const configured = Boolean(PUBLIC_KEY && ASSISTANT_ID);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, activity]);

  useEffect(() => () => void vapiRef.current?.stop(), []);

  async function getVapi(): Promise<Vapi> {
    if (vapiRef.current) return vapiRef.current;
    const { default: VapiCtor } = await import("@vapi-ai/web");
    const vapi = new VapiCtor(PUBLIC_KEY!);

    vapi.on("call-start", () => {
      setStatus("live");
      onActiveChange(true);
    });
    vapi.on("call-end", () => {
      setStatus("ended");
      setActivity(null);
      setVolume(0);
      onActiveChange(false);
    });
    vapi.on("volume-level", (v: number) => setVolume(v));
    vapi.on("error", (e: unknown) => {
      console.error("[vapi]", e);
      setError("The call couldn't connect. Check microphone permission and try again.");
      setStatus("error");
      onActiveChange(false);
    });
    vapi.on("message", (m: Record<string, unknown>) => {
      if (m.type === "transcript") {
        const role = m.role === "assistant" ? "assistant" : "user";
        const text = String(m.transcript ?? "");
        const final = m.transcriptType === "final";
        setLines((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === role && !last.final) {
            return [...prev.slice(0, -1), { ...last, text, final }];
          }
          return [...prev, { id: ++idRef.current, role, text, final }];
        });
      } else if (m.type === "tool-calls") {
        const list = (m.toolCallList as { function?: { name?: string } }[] | undefined) ?? [];
        const name = list[0]?.function?.name;
        if (name) setActivity(TOOL_LABELS[name] ?? "Working");
      } else if (m.type === "tool-calls-result") {
        setActivity(null);
        onToolResult();
      }
    });
    vapiRef.current = vapi;
    return vapi;
  }

  async function start() {
    setError(null);
    setLines([]);
    setStatus("connecting");
    try {
      const vapi = await getVapi();
      await vapi.start(ASSISTANT_ID!, { variableValues: { today_line: todayLine(new Date()) } });
    } catch (e) {
      console.error(e);
      setError("The call couldn't start. Check microphone permission and try again.");
      setStatus("error");
    }
  }

  async function stop() {
    await vapiRef.current?.stop();
  }

  function toggleMute() {
    const v = vapiRef.current;
    if (!v) return;
    v.setMuted(!muted);
    setMuted(!muted);
  }

  const live = status === "live";
  const ring = Math.min(1, volume * 2.5);

  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-col items-center px-6 pb-6 pt-8 text-center">
        <div className="relative grid size-28 place-items-center">
          {live && (
            <span
              className="absolute inset-0 rounded-full bg-primary/25 transition-transform duration-100"
              style={{ transform: `scale(${1 + ring * 0.45})` }}
            />
          )}
          {status === "connecting" && (
            <span className="absolute inset-0 rounded-full bg-primary/30 [animation:pulse-ring_1.2s_ease-out_infinite]" />
          )}
          <button
            type="button"
            onClick={live ? stop : start}
            disabled={!configured || status === "connecting"}
            className={`relative grid size-24 place-items-center rounded-full text-white shadow-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              live ? "bg-danger hover:opacity-90" : "bg-primary hover:opacity-90"
            }`}
            aria-label={live ? "End call" : "Start call"}
          >
            {live ? <HangUpIcon /> : <PhoneIcon />}
          </button>
        </div>

        <h2 className="mt-5 text-lg font-semibold tracking-tight">
          {status === "connecting" ? "Connecting…" : live ? "Riley is on the line" : "Talk to the receptionist"}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {!configured
            ? "Voice isn't configured on this deployment yet."
            : live
              ? "Speak normally. You can interrupt her."
              : "Uses your microphone. Calls are capped at 4 minutes."}
        </p>

        {live && (
          <button
            type="button"
            onClick={toggleMute}
            className="mt-3 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:text-foreground"
          >
            {muted ? "Unmute mic" : "Mute mic"}
          </button>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>

      <div className="border-t border-border">
        <div ref={scrollRef} className="h-72 space-y-3 overflow-y-auto px-6 py-5">
          {lines.length === 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Try saying</p>
              <ul className="mt-3 space-y-2">
                {TRY_SAYING.map((t) => (
                  <li key={t} className="rounded-xl bg-background px-3.5 py-2.5 text-[15px] text-foreground/80">
                    “{t}”
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            lines.map((l) => (
              <div key={l.id} className={`flex ${l.role === "user" ? "justify-end" : "justify-start"}`}>
                <p
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed ${
                    l.role === "user" ? "bg-primary text-white" : "bg-background text-foreground"
                  } ${l.final ? "" : "opacity-60"}`}
                >
                  {l.text}
                </p>
              </div>
            ))
          )}
          {activity && (
            <p className="flex items-center gap-2 text-sm text-primary">
              <span className="size-2 animate-pulse rounded-full bg-primary" />
              {activity}…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293a1.125 1.125 0 0 1-1.21.38 12.035 12.035 0 0 1-7.143-7.143 1.125 1.125 0 0 1 .38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z"
      />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}
