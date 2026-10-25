import { runMigrations } from "../../db/migrate.js";
import { closePool, getPool } from "../../src/db.js";

/**
 * DB-backed worker tests are destructive: they truncate every table. They only run when
 * TEST_DATABASE_URL points at a dedicated test database — never the production DATABASE_URL.
 * Set TEST_DATABASE_URL in `.env` (or the environment) to enable them.
 */
export const hasDb = Boolean(process.env.TEST_DATABASE_URL);

function assertTestDatabase(): void {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl || process.env.DATABASE_URL !== testUrl) {
    throw new Error(
      "Refusing to run destructive tests: set TEST_DATABASE_URL to a dedicated test database.",
    );
  }
}

export async function migrate(): Promise<void> {
  assertTestDatabase();
  await runMigrations(() => {});
}

export async function resetTables(): Promise<void> {
  assertTestDatabase();
  await getPool().query(
    "truncate table job_removals, ai_request_log, ingest_cursors, hidden_jobs, applications, saved_jobs, job_sources, jobs, companies, runs, users restart identity cascade",
  );
}

export { closePool };
