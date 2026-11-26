// Applies db/schema.sql and seeds demo data.  Usage: DATABASE_URL=... npx tsx scripts/migrate.ts [--no-seed]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSql } from "../src/lib/db";
import { resetDemo } from "../src/lib/state";

async function main() {
  const sql = getSql();
  await sql.unsafe(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
  console.log("schema applied");
  if (!process.argv.includes("--no-seed")) {
    const r = await resetDemo(sql, new Date());
    console.log(`seeded ${r.seeded} demo appointments`);
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
