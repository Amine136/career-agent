/**
 * Per-country share of a run's accepted-job target.
 *
 * The configured shares sum to 1.0 (with `INGEST_MAX_JOBS`, e.g. 1000, they become per-country
 * targets of 250/250/200/100/100/50/50). Each country target is then split evenly between
 * confirmed-remote and non-remote (on-site/hybrid/unknown) acceptances, which gives the
 * run-level 50% remote / 50% non-remote mix.
 *
 * Countries that are not listed get a target of 0 and are not ingested. Set
 * `INGEST_COUNTRY_QUOTAS=off` to fall back to the legacy flat `INGEST_MAX_JOBS_PER_COUNTRY` cap.
 */
export interface CountryQuotaShare {
  iso: string;
  share: number;
}

/**
 * Ireland + UK share the 20% group as 10% each; UAE + Saudi Arabia share the 10% group as
 * 5% each. Change the individual fractions here if the split inside a group should differ.
 */
export const COUNTRY_QUOTA_SHARES: CountryQuotaShare[] = [
  { iso: "DE", share: 0.25 },
  { iso: "CA", share: 0.25 },
  { iso: "NL", share: 0.2 },
  { iso: "IE", share: 0.1 },
  { iso: "GB", share: 0.1 },
  { iso: "AE", share: 0.05 },
  { iso: "SA", share: 0.05 },
];

export function defaultCountryShares(): Record<string, number> {
  return Object.fromEntries(COUNTRY_QUOTA_SHARES.map((quota) => [quota.iso, quota.share]));
}
