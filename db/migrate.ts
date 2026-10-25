import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { Client } from "pg";
import { resolveConnectionConfig } from "../src/connection.js";

const currentFile = fileURLToPath(import.meta.url);
const migrationsDir = join(dirname(currentFile), "migrations");

/** Apply all pending SQL migrations. Returns the number applied. */
export async function runMigrations(log = console.log): Promise<number> {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL (or DIRECT_URL) is not set. Copy .env.example to .env and fill it in.",
    );
  }

  const client = new Client(resolveConnectionConfig(connectionString));
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        log(`skip    ${file}`);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), "utf8");
      log(`apply   ${file}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        count += 1;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }

    log(count === 0 ? "Database is up to date." : `Applied ${count} migration(s).`);
    return count;
  } finally {
    await client.end();
  }
}

const isDirectRun = process.argv[1] ? resolve(process.argv[1]) === resolve(currentFile) : false;

if (isDirectRun) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
