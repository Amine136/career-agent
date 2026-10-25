import "dotenv/config";
import { closePool, withClient } from "../src/db.js";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): number {
  if (text.length === 0) return 0;
  return text.split(" ").filter((w) => w.length > 0).length;
}

// Standard heuristic for English: ~1 token per 4 characters (OpenAI rule of thumb).
function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return {
    count: values.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    median,
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!,
    p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!,
  };
}

function fmt(label: string, s: ReturnType<typeof stats>) {
  if (!s) {
    console.log(`${label}: no data`);
    return;
  }
  console.log(
    `${label}\n` +
      `  jobs: ${s.count}\n` +
      `  min: ${s.min}  max: ${s.max}\n` +
      `  avg (mean): ${s.mean.toFixed(1)}  median: ${s.median}\n` +
      `  p90: ${s.p90}  p99: ${s.p99}`,
  );
}

async function main() {
  const { total, all } = await withClient(async (client) => {
    const totalResult = await client.query<{ count: string }>(
      "select count(*)::text as count from jobs",
    );
    const rows = await client.query<{
      description: string | null;
      is_active: boolean;
      source_count: number;
    }>("select description, is_active, source_count from jobs");
    return { total: totalResult.rows[0]!.count, all: rows.rows };
  });
  const withDesc = all.filter((r) => r.description && stripHtml(r.description).length > 0);
  const emptyDesc = all.length - withDesc.length;

  const wordCounts: number[] = [];
  const tokenCounts: number[] = [];
  const charCounts: number[] = [];

  for (const row of withDesc) {
    const text = stripHtml(row.description!);
    wordCounts.push(words(text));
    tokenCounts.push(estimatedTokens(text));
    charCounts.push(text.length);
  }

  console.log(`Jobs in DB: ${total}`);
  console.log(`Rows fetched: ${all.length}`);
  console.log(`With non-empty description: ${withDesc.length}`);
  console.log(`Without / empty description: ${emptyDesc}`);
  console.log(
    `Active: ${all.filter((r) => r.is_active).length}  Inactive: ${all.filter((r) => !r.is_active).length}`,
  );
  console.log("");
  fmt("Words per description", stats(wordCounts));
  console.log("");
  fmt("Estimated tokens per description (chars/4)", stats(tokenCounts));
  console.log("");
  fmt("Characters per description", stats(charCounts));

  const avgWords = wordCounts.reduce((a, b) => a + b, 0) / (wordCounts.length || 1);
  const avgTokens = tokenCounts.reduce((a, b) => a + b, 0) / (tokenCounts.length || 1);
  console.log("");
  console.log(`Cross-check: avg words=${avgWords.toFixed(1)}, avg words*1.33=${(avgWords * 1.33).toFixed(1)}, avg tokens(chars/4)=${avgTokens.toFixed(1)}`);

  if (process.env.DUMP) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      process.env.DUMP,
      JSON.stringify(withDesc.map((row) => stripHtml(row.description!))),
    );
    console.log(`\nDumped ${withDesc.length} stripped descriptions to ${process.env.DUMP}`);
  }

  await closePool();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
