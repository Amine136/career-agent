import { withClient, type PoolClient } from "../db.js";

export type IngestCursor = Record<string, unknown>;

/** Read the stored resume cursor for a source, or null when none exists. */
export async function getIngestCursor(source: string): Promise<IngestCursor | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ cursor: IngestCursor }>(
      "select cursor from ingest_cursors where source = $1",
      [source],
    );
    return rows[0]?.cursor ?? null;
  });
}

/** Persist the resume cursor for a source (call inside a transaction). */
export async function saveIngestCursor(
  client: PoolClient,
  source: string,
  cursor: IngestCursor,
): Promise<void> {
  await client.query(
    `insert into ingest_cursors (source, cursor, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (source) do update set cursor = excluded.cursor, updated_at = now()`,
    [source, JSON.stringify(cursor)],
  );
}
