-- Northgate Family Dental voice receptionist demo (fictional clinic).
-- Safe to run repeatedly.

create extension if not exists btree_gist;

create table if not exists dentists (
  id   text primary key,
  name text not null
);

create table if not exists appointments (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,            -- confirmation code read to the caller
  dentist_id       text not null references dentists(id),
  patient_name     text not null,
  phone            text not null,                   -- digits only
  appointment_type text not null check (appointment_type in ('checkup','cleaning','emergency','consultation')),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'booked' check (status in ('booked','cancelled')),
  notes            text,
  call_id          text,                            -- Vapi call that created it (null for seed data)
  seeded           boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at > starts_at),
  -- The database itself refuses two live bookings for one dentist that overlap,
  -- even if two calls try at the same instant.
  constraint no_double_booking exclude using gist (
    dentist_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status = 'booked')
);

create index if not exists appointments_phone_idx on appointments (phone) where status = 'booked';
create index if not exists appointments_starts_idx on appointments (starts_at) where status = 'booked';

-- Every tool call Vapi sends, keyed by its toolCallId. A retried webhook replays
-- the stored result instead of booking twice.
create table if not exists tool_calls (
  tool_call_id text primary key,
  call_id      text,
  name         text not null,
  arguments    jsonb not null,
  result       text,
  outcome      text,          -- booked | rescheduled | cancelled | flagged | info | rejected
  created_at   timestamptz not null default now()
);

create index if not exists tool_calls_call_idx on tool_calls (call_id);

create table if not exists staff_tasks (
  id           uuid primary key default gen_random_uuid(),
  call_id      text,
  urgency      text not null check (urgency in ('emergency','callback')),
  reason       text not null,
  patient_name text,
  phone        text,
  done         boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists calls (
  call_id      text primary key,
  started_at   timestamptz,
  ended_at     timestamptz,
  ended_reason text,
  transcript   text,
  messages     jsonb,
  cost_usd     numeric(10,4),
  created_at   timestamptz not null default now()
);
