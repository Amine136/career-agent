import "dotenv/config";

// Destructive worker tests (migrations + table truncation) must NEVER touch the production
// database. When TEST_DATABASE_URL is set we redirect the worker pool to it; when it is not,
// the DB-backed suites skip (see tests/helpers/db.ts).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  // `db/migrate.ts` prefers DIRECT_URL, so point that at the test DB too.
  process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
}
