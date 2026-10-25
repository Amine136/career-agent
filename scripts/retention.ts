import "dotenv/config";
import { applyRetention } from "../src/core/retention.js";
import { closePool } from "../src/db.js";

async function main(): Promise<void> {
  const result = await applyRetention();
  console.log(`retention: deleted=${result.deleted}`);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
