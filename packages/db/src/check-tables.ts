import postgres from "postgres";

async function main() {
  const sql = postgres("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
  try {
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
    console.log("Total public tables:", tables.length);

    try {
      const drizzleRows = await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 10`;
      console.log("drizzle.__drizzle_migrations count:", drizzleRows.length);
      console.log("Latest drizzle migrations:", drizzleRows);
    } catch (e: any) {
      console.log("drizzle schema error:", e.message);
    }

    try {
      const publicDrizzle = await sql`SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 10`;
      console.log("public.__drizzle_migrations count:", publicDrizzle.length);
      console.log("Latest public migrations:", publicDrizzle);
    } catch (e: any) {
      console.log("public.__drizzle error:", e.message);
    }
  } finally {
    await sql.end();
  }
}

main().catch(console.error);
