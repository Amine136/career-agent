import "dotenv/config";
import { detectRemote } from "../src/core/remote.js";
import { closePool, getPool } from "../src/db.js";

/**
 * One-shot repair for the remote-classification bug.
 *
 * LinkedIn's remote-only search (`f_WT=2`) used to force `remote = true` on every hit, including
 * on-site roles. The scorer then echoed that flag back as an authoritative `ai_workplace =
 * 'remote'`, so those roles surfaced under "Remote only".
 *
 * This recomputes the deterministic `jobs.remote` flag from the posting text (the same
 * `detectRemote` heuristic used at ingestion) and can requeue the false positives for re-scoring.
 *
 *   tsx scripts/repair-remote.ts                  # dry run: report what would change
 *   tsx scripts/repair-remote.ts --apply          # write the corrected `remote` flags
 *   tsx scripts/repair-remote.ts --apply --requeue # also requeue false-positive AI 'remote' rows
 *
 * `--requeue` spends the Gemini daily budget (15/min, 500-1000/day) on the next `pnpm score`.
 */
interface JobRow {
  id: string;
  title: string | null;
  company_name: string | null;
  city: string | null;
  region: string | null;
  description: string | null;
  snippet: string | null;
  remote: boolean;
  ai_workplace: string | null;
}

function heuristicRemote(row: JobRow): boolean {
  const location = [row.region, row.city]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(", ");
  return detectRemote({
    location,
    title: row.title,
    description: row.description ?? row.snippet,
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const requeue = process.argv.includes("--requeue");
  if (requeue && !apply) {
    throw new Error("--requeue requires --apply so the corrected `remote` flags are written first");
  }

  const pool = getPool();
  const { rows } = await pool.query<JobRow>(
    `select id, title, company_name, city, region, description, snippet, remote, ai_workplace
       from jobs
      where is_active = true`,
  );

  const toRemote: JobRow[] = [];
  const toOnsite: JobRow[] = [];
  for (const row of rows) {
    const next = heuristicRemote(row);
    if (next === row.remote) continue;
    (next ? toRemote : toOnsite).push(row);
  }

  console.log(
    `repair:remote ${apply ? "(apply)" : "(dry run)"} — scanned ${rows.length}, ` +
      `remote→false ${toOnsite.length}, false→true ${toRemote.length}`,
  );
  for (const row of toOnsite.slice(0, 10)) {
    console.log(`  remote→false  ${row.company_name ?? "?"} — ${row.title ?? "?"} (ai=${row.ai_workplace ?? "null"})`);
  }
  for (const row of toRemote.slice(0, 10)) {
    console.log(`  false→true    ${row.company_name ?? "?"} — ${row.title ?? "?"}`);
  }

  const falsePositives = toOnsite.filter((row) => row.ai_workplace === "remote");
  console.log(
    `  AI 'remote' verdicts flagged as false positives: ${falsePositives.length}` +
      (requeue ? " (requeued below)" : ""),
  );

  if (!apply) {
    console.log("dry run: re-run with --apply to write changes (add --requeue to re-score).");
    return;
  }

  const changed = [...toOnsite, ...toRemote];
  if (changed.length > 0) {
    await pool.query(
      `update jobs as j
          set remote = v.remote,
              updated_at = now()
         from unnest($1::uuid[], $2::boolean[]) as v(id, remote)
        where j.id = v.id`,
      [changed.map((row) => row.id), changed.map((row) => heuristicRemote(row))],
    );
  }

  if (requeue && falsePositives.length > 0) {
    await pool.query(
      `update jobs set ai_scored_at = null where id = any($1::uuid[])`,
      [falsePositives.map((row) => row.id)],
    );
    console.log(`requeued ${falsePositives.length} false-positive AI 'remote' job(s) for re-scoring`);
  }

  console.log(`updated ${changed.length} job(s)`);
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
