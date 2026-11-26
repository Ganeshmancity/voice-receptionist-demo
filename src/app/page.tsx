import { Demo } from "@/components/demo";

const GUARANTEES = [
  {
    title: "No double bookings, even at the same second",
    body: "Each dentist's schedule is protected by a Postgres exclusion constraint. If two callers grab the same slot, the database lets exactly one through and the other caller is offered the nearest open times.",
  },
  {
    title: "Retries never book twice",
    body: "Every tool call is stored by its ID before it runs. If the voice platform sends the same request again, it gets the original answer back instead of creating a second appointment.",
  },
  {
    title: "Reschedules are all-or-nothing",
    body: "The old slot is released only in the same transaction that secures the new one. If the new time fails, the caller keeps their original appointment.",
  },
  {
    title: "Urgent calls reach a human",
    body: "Severe pain, swelling or injury is flagged for the on-call team, and life-threatening symptoms get a 911 instruction. Billing and anything off-script become a staff callback.",
  },
  {
    title: "Caller details stay private",
    body: "Cancelling or moving a visit needs both the confirmation code and the phone number. On this public page, names, codes and phone numbers are masked.",
  },
  {
    title: "Real clinic rules",
    body: "Opening hours, lunch break, each dentist's working days, minimum notice and booking window are all enforced on the server in the clinic's own timezone, including daylight-saving changes.",
  },
];

export default function Home() {
  return (
    <main className="flex-1">
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-sm font-semibold text-white">N</span>
            <span className="font-semibold tracking-tight">Northgate Family Dental</span>
            <span className="hidden rounded-full border border-border px-2 py-0.5 text-xs text-muted sm:inline">fictional demo clinic</span>
          </div>
          <a
            href="https://github.com/Ganeshmancity/voice-receptionist-demo"
            className="shrink-0 text-sm text-muted transition-colors hover:text-foreground"
          >
            Source on GitHub →
          </a>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-10 pt-14 sm:pt-20">
        <p className="text-sm font-medium text-primary">AI voice receptionist · live demo</p>
        <h1 className="mt-3 max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Call the front desk. Watch it book.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl">
          Riley answers like a real receptionist: checks the schedule, books, reschedules and cancels visits, and passes
          urgent cases to staff. Every booking lands in a real database, and the live schedule updates as you talk.
        </p>
      </section>

      <Demo />

      <section className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">What&apos;s under the hood</h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Voice runs on Vapi (speech-to-text, LLM, text-to-speech). Every decision that matters (availability, booking,
          changes) is made by a Next.js + Postgres backend the agent calls as tools, so the AI can&apos;t invent a slot or a
          confirmation code.
        </p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {GUARANTEES.map((g) => (
            <div key={g.title} className="rounded-2xl border border-border bg-card p-6">
              <h3 className="text-lg font-semibold tracking-tight">{g.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{g.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 text-sm text-muted">
          Demo only. Northgate Family Dental is fictional. Don&apos;t share real health details. Calls are capped at 4
          minutes and demo data resets daily.
        </div>
      </footer>
    </main>
  );
}
