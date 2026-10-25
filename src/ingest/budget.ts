/**
 * Per-run ingestion budget shared by every source in one invocation.
 *
 * The scheduler runs Indeed and LinkedIn back to back in a single process. This budget counts the
 * jobs actually inserted (stored) so a run collects at most `maxTotal` overall and at most the
 * per-country target across both sources. Once a country is at its cap its remaining
 * searches/pages are skipped, and once the total is reached the whole run stops early.
 *
 * Two allocation modes:
 * - **Shares** (`countryShares` present, the default): each country gets `maxTotal * share`
 *   accepted jobs, split `remoteShare` (default 50%) confirmed-remote and the rest non-remote.
 *   Countries not listed have a target of 0 and are not ingested.
 * - **Legacy** (`countryShares` absent): the historical flat `maxPerCountry` cap with an optional
 *   remote-only quota. Kept for direct callers/tests and `INGEST_COUNTRY_QUOTAS=off`.
 *
 * A separate remote quota backs the remote-first passes: remote tasks run before the generic
 * sweep and stop once this quota is met, so remote roles are not crowded out by the (larger)
 * non-remote pool.
 */

import { defaultCountryShares } from "../../config/index.js";

export const DEFAULT_MAX_JOBS_PER_RUN = 1000;
export const DEFAULT_MAX_JOBS_PER_COUNTRY = 100;
/** Fraction of each country target reserved for confirmed-remote jobs; override with INGEST_REMOTE_SHARE. */
export const DEFAULT_REMOTE_SHARE = 0.5;

export interface IngestLimits {
  /** Hard cap on inserted jobs for the whole run (all sources, all countries). */
  maxTotal: number;
  /** Legacy flat cap on inserted jobs per country (used only when `countryShares` is absent). */
  maxPerCountry: number;
  /** Legacy remote-only quota (used only when `countryShares` is absent). */
  maxRemotePerCountry?: number;
  /**
   * Per-country share of `maxTotal`. When present, replaces `maxPerCountry` with
   * `round(maxTotal * share)` targets; unlisted countries get a target of 0.
   */
  countryShares?: Record<string, number>;
  /** Fraction of each country target reserved for confirmed-remote jobs (default 0.5). */
  remoteShare?: number;
}

export interface CountryTarget {
  total: number;
  remote: number;
  nonRemote: number;
}

export interface IngestBudgetSnapshot {
  maxTotal: number;
  maxPerCountry: number;
  maxRemotePerCountry: number;
  total: number;
  remoteTotal: number;
  /** Valid-looking jobs left unprocessed because a cap was reached. */
  skipped: number;
  totalReached: boolean;
  perCountry: Record<string, number>;
  remotePerCountry: Record<string, number>;
  countriesAtLimit: string[];
  remoteCountriesAtLimit: string[];
  /** Per-country targets when share mode is active. */
  targets?: Record<string, CountryTarget>;
  remoteShare?: number;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envFloat(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** Derive the remote per-country cap from a country cap and a 0..1 share. */
export function remoteCapFromShare(maxPerCountry: number, share = DEFAULT_REMOTE_SHARE): number {
  return Math.round(maxPerCountry * share);
}

/**
 * Parse `INGEST_COUNTRY_QUOTAS`:
 * - unset → the configured 25/25/20/10/10/5/5 shares,
 * - `off` (or empty) → legacy flat mode,
 * - `DE=0.25,CA=0.25,...` → explicit per-country shares.
 */
function parseCountryShares(raw: string | undefined): Record<string, number> | undefined {
  if (raw === undefined) return defaultCountryShares();
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "off") return undefined;
  const shares: Record<string, number> = {};
  for (const part of trimmed.split(",")) {
    const [isoPart, valuePart] = part.split("=");
    const iso = isoPart?.trim().toUpperCase();
    const value = Number(valuePart);
    if (iso && Number.isFinite(value) && value >= 0 && value <= 1) {
      shares[iso] = value;
    }
  }
  return Object.keys(shares).length > 0 ? shares : undefined;
}

/**
 * Turn fractional shares into integer targets with largest-remainder rounding, so the targets sum
 * to `round(maxTotal * sum(shares))` (the configured shares sum to 1 → the full run total).
 */
export function computeCountryTargets(
  maxTotal: number,
  shares: Record<string, number>,
  remoteShare = DEFAULT_REMOTE_SHARE,
): Map<string, CountryTarget> {
  const entries = Object.entries(shares).filter(
    ([, share]) => Number.isFinite(share) && share > 0,
  );
  const targets = new Map<string, CountryTarget>();
  if (entries.length === 0) return targets;

  const shareSum = entries.reduce((sum, [, share]) => sum + share, 0);
  const targetSum = Math.min(maxTotal, Math.round(maxTotal * shareSum));
  const bases = entries.map(([iso, share]) => {
    const exact = maxTotal * share;
    const base = Math.floor(exact);
    return { iso, base, remainder: exact - base };
  });

  let assigned = bases.reduce((sum, entry) => sum + entry.base, 0);
  for (const entry of [...bases].sort((a, b) => b.remainder - a.remainder)) {
    if (assigned >= targetSum) break;
    entry.base += 1;
    assigned += 1;
  }

  for (const entry of bases) {
    const remote = Math.floor(entry.base * remoteShare);
    targets.set(entry.iso, {
      total: entry.base,
      remote,
      nonRemote: entry.base - remote,
    });
  }
  return targets;
}

/** Resolve the caps from the environment (defaults 1000/run + the configured country shares). */
export function resolveIngestLimits(env: NodeJS.ProcessEnv = process.env): IngestLimits {
  const maxPerCountry = envInt(env, "INGEST_MAX_JOBS_PER_COUNTRY", DEFAULT_MAX_JOBS_PER_COUNTRY);
  const remoteShare = envFloat(env, "INGEST_REMOTE_SHARE", DEFAULT_REMOTE_SHARE);
  const maxRemotePerCountry = envInt(
    env,
    "INGEST_MAX_REMOTE_JOBS_PER_COUNTRY",
    remoteCapFromShare(maxPerCountry, remoteShare),
  );
  return {
    maxTotal: envInt(env, "INGEST_MAX_JOBS", DEFAULT_MAX_JOBS_PER_RUN),
    maxPerCountry,
    maxRemotePerCountry,
    countryShares: parseCountryShares(env.INGEST_COUNTRY_QUOTAS),
    remoteShare,
  };
}

export class IngestBudget {
  readonly limits: IngestLimits;
  readonly maxRemotePerCountry: number;
  /** Countries at their selected target, in priority-independent ISO order. */
  private readonly targets: Map<string, CountryTarget> | null;
  private total = 0;
  private remoteTotal = 0;
  private skipped = 0;
  private readonly perCountry = new Map<string, number>();
  private readonly remotePerCountry = new Map<string, number>();

  constructor(limits: IngestLimits = resolveIngestLimits()) {
    this.limits = limits;
    this.maxRemotePerCountry =
      limits.maxRemotePerCountry ?? remoteCapFromShare(limits.maxPerCountry);
    this.targets = limits.countryShares
      ? computeCountryTargets(
          limits.maxTotal,
          limits.countryShares,
          limits.remoteShare ?? DEFAULT_REMOTE_SHARE,
        )
      : null;
  }

  /** True when share mode is active (per-country targets + 50/50 remote split). */
  get usesCountryShares(): boolean {
    return this.targets !== null;
  }

  private key(countryCode: string | null | undefined): string {
    return (countryCode ?? "").toUpperCase();
  }

  private target(countryCode: string | null | undefined): CountryTarget | undefined {
    return this.targets?.get(this.key(countryCode));
  }

  get totalReached(): boolean {
    return this.total >= this.limits.maxTotal;
  }

  count(countryCode: string | null | undefined): number {
    return this.perCountry.get(this.key(countryCode)) ?? 0;
  }

  remoteCount(countryCode: string | null | undefined): number {
    return this.remotePerCountry.get(this.key(countryCode)) ?? 0;
  }

  nonRemoteCount(countryCode: string | null | undefined): number {
    return this.count(countryCode) - this.remoteCount(countryCode);
  }

  /** Accepted-job target for a country (share mode) or the flat legacy cap. */
  countryTarget(countryCode: string | null | undefined): number {
    if (this.targets) return this.target(countryCode)?.total ?? 0;
    return this.limits.maxPerCountry;
  }

  /** Confirmed-remote target for a country. */
  remoteTarget(countryCode: string | null | undefined): number {
    if (this.targets) return this.target(countryCode)?.remote ?? 0;
    return this.maxRemotePerCountry;
  }

  /** Non-remote target, or null when the legacy mode has no separate non-remote quota. */
  nonRemoteTarget(countryCode: string | null | undefined): number | null {
    if (!this.targets) return null;
    return this.target(countryCode)?.nonRemote ?? 0;
  }

  /** How many more accepted jobs this country can take (for deficit-based search ordering). */
  remaining(countryCode: string | null | undefined): number {
    return Math.max(0, this.countryTarget(countryCode) - this.count(countryCode));
  }

  /** How many more confirmed-remote jobs this country can take. */
  remoteRemaining(countryCode: string | null | undefined): number {
    return Math.max(0, this.remoteTarget(countryCode) - this.remoteCount(countryCode));
  }

  countryAtLimit(countryCode: string | null | undefined): boolean {
    return this.count(countryCode) >= this.countryTarget(countryCode);
  }

  /** True once a country has accepted its remote quota; the remote passes stop here. */
  remoteAtLimit(countryCode: string | null | undefined): boolean {
    return this.remoteCount(countryCode) >= this.remoteTarget(countryCode);
  }

  /** True once the non-remote half is full (share mode only). */
  nonRemoteAtLimit(countryCode: string | null | undefined): boolean {
    if (!this.targets) return false;
    return this.nonRemoteCount(countryCode) >= (this.nonRemoteTarget(countryCode) ?? 0);
  }

  /**
   * True when another accepted job from this country is still allowed. Remote jobs respect the
   * remote quota; in share mode non-remote jobs respect the non-remote half. In legacy mode the
   * generic sweep may still accept remote jobs (historical behaviour).
   */
  canAccept(countryCode: string | null | undefined, remote = false): boolean {
    if (this.totalReached) return false;
    if (this.countryAtLimit(countryCode)) return false;
    if (remote) return !this.remoteAtLimit(countryCode);
    if (this.targets) return !this.nonRemoteAtLimit(countryCode);
    return true;
  }

  record(countryCode: string | null | undefined, remote = false): void {
    this.total += 1;
    const key = this.key(countryCode);
    this.perCountry.set(key, (this.perCountry.get(key) ?? 0) + 1);
    if (remote) {
      this.remoteTotal += 1;
      this.remotePerCountry.set(key, (this.remotePerCountry.get(key) ?? 0) + 1);
    }
  }

  /** Count jobs that were dropped because a cap was reached (already-validated jobs). */
  recordSkipped(count = 1): void {
    if (count > 0) this.skipped += count;
  }

  snapshot(): IngestBudgetSnapshot {
    return {
      maxTotal: this.limits.maxTotal,
      maxPerCountry: this.limits.maxPerCountry,
      maxRemotePerCountry: this.maxRemotePerCountry,
      total: this.total,
      remoteTotal: this.remoteTotal,
      skipped: this.skipped,
      totalReached: this.totalReached,
      perCountry: Object.fromEntries(this.perCountry),
      remotePerCountry: Object.fromEntries(this.remotePerCountry),
      countriesAtLimit: [...this.perCountry.keys()]
        .filter((code) => this.countryAtLimit(code))
        .sort(),
      remoteCountriesAtLimit: [...this.remotePerCountry.keys()]
        .filter((code) => this.remoteAtLimit(code))
        .sort(),
      targets: this.targets
        ? Object.fromEntries(
            [...this.targets.entries()].map(([iso, target]) => [iso, { ...target }]),
          )
        : undefined,
      remoteShare: this.limits.remoteShare,
    };
  }
}
