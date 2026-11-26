import postgres from "postgres";

export type Sql = postgres.Sql;
/** Anything you can run a query on: the pool or an open transaction. */
export type Q = postgres.ISql;

let client: Sql | null = null;

/** One small pool per server instance. `prepare: false` keeps it compatible with transaction poolers (Supabase/Neon). */
export function getSql(): Sql {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  client = postgres(url, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return client;
}

export function isPgError(e: unknown, code: string): e is postgres.PostgresError {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === code;
}

export const PG = {
  exclusionViolation: "23P01",
  uniqueViolation: "23505",
} as const;
