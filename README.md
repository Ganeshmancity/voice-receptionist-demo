# AI Voice Receptionist: books real appointments

**Live demo:** https://voice-receptionist-demo-ebon.vercel.app (click the phone button and talk; uses your microphone, calls capped at 4 minutes)

A phone-style AI receptionist for a (fictional) dental clinic. You talk to it in the browser; it checks a real
schedule, books, reschedules and cancels visits, and hands urgent or off-script calls to staff. The schedule,
staff alerts and call log on the page update live from Postgres while you talk.

**Stack:** Vapi (speech-to-text → LLM → text-to-speech) · Next.js 16 route handlers · Postgres · Vitest · GitHub Actions

## Why it's built this way

The LLM never decides anything that matters. It calls six server tools, and the backend enforces the rules:

| Tool | What the server guarantees |
|---|---|
| `check_availability` | Real open slots from opening hours, lunch break, each dentist's working days, 1-hour minimum notice, 30-day window, all in the clinic's timezone (DST-safe). Also tells the agent today's date. |
| `book_appointment` | **No double booking, even under a race:** a Postgres `EXCLUDE USING gist (dentist_id WITH =, tstzrange(starts_at, ends_at) WITH &&)` constraint. If the requested dentist is taken it tries the other; if both are taken it returns the nearest alternatives. The same caller can't be in two chairs at once. |
| `find_appointments` | Upcoming visits by phone number. |
| `cancel_appointment` | Needs **code + phone** to match, so nobody cancels a visit by guessing a code. Spoken codes ("k seven q two p") are normalised. |
| `reschedule_appointment` | **All-or-nothing:** the old slot is released in the same transaction that inserts the new one. If the new time is taken, the original appointment stays. |
| `flag_for_staff` | Emergencies (severe pain, swelling, knocked-out tooth) go to an urgent queue; billing/insurance/complaints become callbacks. Life-threatening symptoms get a 911 instruction first. |

**Webhook retries never double-book.** Every tool call is stored by Vapi's `toolCallId` *before* it runs
(`insert … on conflict do nothing`). A duplicate delivery waits for the first run and replays its answer.

**Privacy on a public demo.** The dashboard masks names ("Maria G."), phone numbers, confirmation codes, and
phone numbers inside transcripts. Calls are capped at 4 minutes and demo data resets daily (Vercel cron).

## Tests

`npm test` runs 29 tests: pure scheduling rules (hours, lunch, Saturdays, DST, grid, notice) plus Postgres
integration tests (CI runs them against a `postgres:16` service):

- 10 simultaneous callers grab the same chair → exactly 1 booking
- the database itself rejects an overlapping insert (`23P01`)
- the same webhook delivered 3× concurrently → 1 booking, identical answers
- reschedule into a taken slot → original kept; shifting into an overlap with its own old time → allowed
- cancel with the wrong phone → refused
- full Vapi `tool-calls` + `end-of-call-report` round trip → dashboard shows outcomes, duration, cost, masked transcript

## Run it yourself

1. Postgres (Supabase/Neon free tier works). `cp .env.example .env.local` and fill it in.
2. `npm install && npm run db:migrate` (creates tables and seeds a demo week).
3. Deploy (e.g. Vercel) with the env vars from `.env.example`.
4. Create the assistant: `VAPI_PRIVATE_KEY=… VAPI_WEBHOOK_SECRET=… APP_URL=https://your-app npm run vapi:assistant`
   then set `NEXT_PUBLIC_VAPI_ASSISTANT_ID` and redeploy.
5. In the Vapi dashboard, restrict the public key to your domain and this assistant.

## Layout

```
src/lib/clinic.ts        hours, dentists, visit types
src/lib/slots.ts         pure slot logic (unit-tested, no DB/clock)
src/lib/booking.ts       Postgres actions: book, reschedule, cancel, flag
src/lib/tools.ts         tool schemas (zod), replay-safe runner, what the agent hears
src/lib/vapi-handler.ts  Vapi server messages → responses
src/lib/assistant.ts     the Vapi assistant: prompt, voice, tools, webhook
src/app/api/vapi         webhook (shared-secret header)
src/app/api/state        dashboard data (masked)
db/schema.sql            tables + exclusion constraint
```
