/**
 * Per-company ingestion guard.
 *
 * Keeps one employer from flooding the catalog: once the company has `cap` newly inserted jobs
 * inside the trailing `windowDays` window, further jobs from it are skipped before the DB write
 * (and therefore before AI scoring). The "blocklist" is derived from the job counts and loaded
 * once per invocation, so it expires automatically as old jobs leave the window — there is no
 * permanent, hand-maintained list.
 *
 * The guard counts only newly inserted rows (`record` is called after `jobInserted`), so a
 * re-sighting of an already-stored job does not consume a slot. Exempt names (generic listings,
 * staffing agencies) are never capped; see `config/company-cap.ts`.
 */

import {
  COMPANY_CAP_EXEMPT_NAMES,
  COMPANY_CAP_EXEMPT_TOKENS,
} from "../../config/index.js";
import { countJobsByCompanySince } from "../core/repository.js";
import { normalizeText } from "../core/normalize.js";
import { withClient } from "../db.js";

export const DEFAULT_COMPANY_CAP = 10;
export const DEFAULT_COMPANY_WINDOW_DAYS = 10;

export interface CompanyLimits {
  /** Newly inserted jobs allowed per company inside the window. 0 disables the guard. */
  cap: number;
  /** Trailing window, in days, measured from `first_seen_at`. */
  windowDays: number;
  /** Log what would be skipped without actually skipping (safe rollout). */
  dryRun?: boolean;
  /** Normalized names that are never capped (defaults to the config list). */
  exemptNames?: string[];
  /** Normalized substrings that mark an agency/generic listing (defaults to the config list). */
  exemptTokens?: string[];
}

export interface CompanyGuardSnapshot {
  enabled: boolean;
  dryRun: boolean;
  cap: number;
  windowDays: number;
  /** Jobs that were skipped (or would be skipped, in dry-run mode). */
  skipped: number;
  /** Companies that hit the cap during this invocation, sorted. */
  cappedCompanies: string[];
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim();
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Resolve the guard from the environment:
 * - `INGEST_COMPANY_CAP` (default 10; `off` or `0` disables),
 * - `INGEST_COMPANY_WINDOW_DAYS` (default 10, minimum 1),
 * - `INGEST_COMPANY_DRY_RUN` (true logs would-be skips without gating),
 * - `INGEST_COMPANY_CAP_EXEMPT` (comma-separated extra normalized names).
 */
export function resolveCompanyLimits(env: NodeJS.ProcessEnv = process.env): CompanyLimits {
  const capRaw = env.INGEST_COMPANY_CAP?.trim().toLowerCase();
  const cap =
    capRaw === "off" ? 0 : envInt(env, "INGEST_COMPANY_CAP", DEFAULT_COMPANY_CAP);
  const windowDays = Math.max(
    1,
    envInt(env, "INGEST_COMPANY_WINDOW_DAYS", DEFAULT_COMPANY_WINDOW_DAYS),
  );
  const extraExempt = (env.INGEST_COMPANY_CAP_EXEMPT ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return {
    cap,
    windowDays,
    dryRun: envFlag(env, "INGEST_COMPANY_DRY_RUN"),
    exemptNames: [...COMPANY_CAP_EXEMPT_NAMES, ...extraExempt].map((name) =>
      normalizeText(name),
    ),
    exemptTokens: COMPANY_CAP_EXEMPT_TOKENS.map((token) => normalizeText(token)),
  };
}

export class CompanyGuard {
  readonly limits: CompanyLimits;
  private readonly counts: Map<string, number>;
  private readonly exemptNames: Set<string>;
  private readonly exemptTokens: string[];
  private skipped = 0;
  private readonly capped = new Set<string>();

  constructor(limits: CompanyLimits, counts: Map<string, number> = new Map()) {
    this.limits = { ...limits, dryRun: limits.dryRun ?? false };
    this.counts = counts;
    this.exemptNames = new Set(
      (limits.exemptNames ?? COMPANY_CAP_EXEMPT_NAMES).map((name) => normalizeText(name)),
    );
    this.exemptTokens = (limits.exemptTokens ?? COMPANY_CAP_EXEMPT_TOKENS).map((token) =>
      normalizeText(token),
    );
  }

  /** A disabled guard that never skips anything (cap 0). */
  static disabled(): CompanyGuard {
    return new CompanyGuard({ cap: 0, windowDays: 0 });
  }

  /**
   * Load the trailing-window counts from Postgres and build a guard for this invocation.
   * Shares one query across every source in the run; counts are then incremented in memory as
   * jobs are inserted so the cap applies within the same sweep.
   */
  static async load(limits = resolveCompanyLimits(), now = new Date()): Promise<CompanyGuard> {
    if (limits.cap <= 0) return new CompanyGuard(limits);
    const rows = await withClient((client) =>
      countJobsByCompanySince(client, limits.windowDays, now),
    );
    return new CompanyGuard(limits, new Map(rows.map((row) => [row.company, row.count])));
  }

  get enabled(): boolean {
    return this.limits.cap > 0;
  }

  get dryRun(): boolean {
    return this.limits.dryRun === true;
  }

  private key(name: string | null | undefined): string {
    return normalizeText(name ?? "");
  }

  private isExempt(key: string): boolean {
    if (!key) return true;
    if (this.exemptNames.has(key)) return true;
    return this.exemptTokens.some((token) => key.includes(token));
  }

  /** Newly inserted jobs recorded for this company in the window. */
  count(name: string | null | undefined): number {
    return this.counts.get(this.key(name)) ?? 0;
  }

  /** True when the company has reached the cap (also true in dry-run mode). */
  atCap(name: string | null | undefined): boolean {
    if (!this.enabled) return false;
    const key = this.key(name);
    if (this.isExempt(key)) return false;
    return (this.counts.get(key) ?? 0) >= this.limits.cap;
  }

  /** True when the guard must actually drop the job (never in dry-run mode). */
  shouldSkip(name: string | null | undefined): boolean {
    return !this.dryRun && this.atCap(name);
  }

  /** How many more inserts this company can take before it is capped. */
  remaining(name: string | null | undefined): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.limits.cap - this.count(name));
  }

  /** Record a successfully inserted job. No-op for disabled guards and exempt companies. */
  record(name: string | null | undefined): void {
    if (!this.enabled) return;
    const key = this.key(name);
    if (!key || this.isExempt(key)) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Record a skipped job; only counts when the company was actually at its cap. */
  recordSkipped(name: string | null | undefined): void {
    if (!this.enabled) return;
    const key = this.key(name);
    if (!this.atCap(key)) return;
    this.skipped += 1;
    this.capped.add(key);
  }

  snapshot(): CompanyGuardSnapshot {
    return {
      enabled: this.enabled,
      dryRun: this.dryRun,
      cap: this.limits.cap,
      windowDays: this.limits.windowDays,
      skipped: this.skipped,
      cappedCompanies: [...this.capped].sort(),
    };
  }
}
