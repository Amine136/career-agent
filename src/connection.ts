export interface ConnectionConfig {
  connectionString: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Managed Postgres (Supabase) requires SSL, but the connection strings shown in
 * some dashboards omit `sslmode`, and pg-connection-string v2 treats `require` as
 * `verify-full`, which fails against Supabase's pooler certificate chain.
 *
 * We remove `sslmode` from the URL and set `ssl` ourselves so the behaviour is explicit:
 *  - `verify-full`/`verify-ca` -> verify the certificate
 *  - `require`/`prefer`/no-verify -> encrypted, verification disabled
 *  - `disable` -> no SSL
 *  - unset -> SSL for non-local hosts, none for localhost
 */
export function resolveConnectionConfig(connectionString: string): ConnectionConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString };
  }

  const host = url.hostname;
  const mode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  const sanitized = url.toString();

  if (mode === "disable") return { connectionString: sanitized, ssl: false };
  if (mode === "verify-full" || mode === "verify-ca") {
    return { connectionString: sanitized, ssl: { rejectUnauthorized: true } };
  }
  if (mode === "require" || mode === "prefer" || mode === "no-verify") {
    return { connectionString: sanitized, ssl: { rejectUnauthorized: false } };
  }

  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  return isLocal
    ? { connectionString: sanitized }
    : { connectionString: sanitized, ssl: { rejectUnauthorized: false } };
}
