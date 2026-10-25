import "dotenv/config";
import { closePool } from "../db.js";
import { ingestAll } from "./pipeline.js";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function splitList(value: string | undefined, separator: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

async function main(): Promise<void> {
  const pagesArg = readArg("pages");
  const reports = await ingestAll({
    sources: splitList(readArg("source"), ","),
    countries: splitList(readArg("countries"), ",")?.map((c) => c.toUpperCase()),
    queries: splitList(readArg("queries"), "|"),
    pages: pagesArg ? Number(pagesArg) : undefined,
  });

  for (const report of reports) {
    const s = report.stats;
    console.log(
      `${report.source}: ${report.status} fetched=${s.jobsFetched} accepted=${s.jobsAccepted} ` +
        `rejected=${s.jobsRejected} inserted=${s.jobsInserted} updated=${s.jobsUpdated} errors=${s.errors.length}`,
    );
    if (s.errors.length > 0) {
      console.log(JSON.stringify({ source: report.source, errors: s.errors }, null, 2));
    }
    if (s.details && Object.keys(s.details).length > 0) {
      console.log(JSON.stringify({ source: report.source, details: s.details }));
    }
  }

  await closePool();
  const failed = reports.some((report) => report.status === "failed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
