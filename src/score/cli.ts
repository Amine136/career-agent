import "dotenv/config";
import { createProviders, loadAiConfig } from "../ai/config.js";
import { scorePendingJobs } from "../ai/scorer.js";
import { closePool } from "../db.js";

/**
 * Scoring cadence: daily at 09:00 UTC (after the last ingestion run and after the Gemini quota
 * reset). Single source of truth for the Cloud Scheduler cron expression.
 */
export const SCORE_SCHEDULE_CRON = "0 9 * * *";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

async function main(): Promise<void> {
  const config = loadAiConfig();
  const providers = createProviders(config);

  const limitArg = readArg("limit");
  const limit = limitArg ? Number(limitArg) : config.maxJobsPerRun;

  const sinceArg = readArg("since");
  const since = sinceArg ? new Date(`${sinceArg}T00:00:00Z`) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`Invalid --since date: ${sinceArg} (expected YYYY-MM-DD)`);
  }

  console.log(
    JSON.stringify({
      event: "score_start",
      provider: providers[0]!.name,
      models: providers.map((provider) => provider.model),
      limit,
      since: since?.toISOString() ?? `${config.lookbackDays}d lookback (UTC)`,
      lookbackDays: config.lookbackDays,
      timeBudgetMs: config.timeBudgetMs,
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      maxRequestsPerDay: config.maxRequestsPerDay,
    }),
  );

  const result = await scorePendingJobs({
    providers,
    limit,
    since,
    lookbackDays: config.lookbackDays,
    requestDelayMs: config.requestDelayMs,
    timeBudgetMs: config.timeBudgetMs,
    maxRetries: config.maxRetries,
    rateLimit: {
      maxPerMinute: config.maxRequestsPerMinute,
      maxPerDay: config.maxRequestsPerDay,
    },
  });

  console.log(JSON.stringify({ event: "score_finished", ...result }));

  await closePool();
  process.exit(result.status === "failed" ? 1 : 0);
}

const isDirectRun =
  process.argv[1]?.endsWith("score/cli.ts") || process.argv[1]?.endsWith("score/cli.js");

if (isDirectRun) {
  main().catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
}
