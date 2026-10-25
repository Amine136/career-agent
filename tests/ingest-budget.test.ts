import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_JOBS_PER_COUNTRY,
  DEFAULT_MAX_JOBS_PER_RUN,
  DEFAULT_REMOTE_SHARE,
  IngestBudget,
  computeCountryTargets,
  remoteCapFromShare,
  resolveIngestLimits,
} from "../src/ingest/budget.js";

describe("resolveIngestLimits", () => {
  it("uses the 1000/run defaults and the configured country shares", () => {
    const limits = resolveIngestLimits({});
    expect(limits.maxTotal).toBe(DEFAULT_MAX_JOBS_PER_RUN);
    expect(limits.maxPerCountry).toBe(DEFAULT_MAX_JOBS_PER_COUNTRY);
    expect(limits.maxRemotePerCountry).toBe(remoteCapFromShare(DEFAULT_MAX_JOBS_PER_COUNTRY));
    expect(limits.remoteShare).toBe(DEFAULT_REMOTE_SHARE);
    expect(limits.countryShares).toEqual({
      DE: 0.25,
      CA: 0.25,
      NL: 0.2,
      IE: 0.1,
      GB: 0.1,
      AE: 0.05,
      SA: 0.05,
    });
  });

  it("reads overrides and ignores invalid values", () => {
    expect(
      resolveIngestLimits({ INGEST_MAX_JOBS: "50", INGEST_MAX_JOBS_PER_COUNTRY: "5" }),
    ).toMatchObject({ maxTotal: 50, maxPerCountry: 5, maxRemotePerCountry: 3 });
    expect(resolveIngestLimits({ INGEST_MAX_JOBS: "nope" }).maxTotal).toBe(DEFAULT_MAX_JOBS_PER_RUN);
    expect(resolveIngestLimits({ INGEST_MAX_JOBS_PER_COUNTRY: "-1" }).maxPerCountry).toBe(
      DEFAULT_MAX_JOBS_PER_COUNTRY,
    );
  });

  it("derives the remote share and honours the legacy explicit cap", () => {
    expect(resolveIngestLimits({ INGEST_REMOTE_SHARE: "0.4" }).remoteShare).toBe(0.4);
    expect(resolveIngestLimits({ INGEST_REMOTE_SHARE: "0.4" }).maxRemotePerCountry).toBe(40);
    expect(resolveIngestLimits({ INGEST_REMOTE_SHARE: "nope" }).remoteShare).toBe(
      DEFAULT_REMOTE_SHARE,
    );
    expect(
      resolveIngestLimits({
        INGEST_MAX_JOBS_PER_COUNTRY: "100",
        INGEST_MAX_REMOTE_JOBS_PER_COUNTRY: "25",
      }).maxRemotePerCountry,
    ).toBe(25);
  });

  it("can disable share mode or override the shares", () => {
    expect(resolveIngestLimits({ INGEST_COUNTRY_QUOTAS: "off" }).countryShares).toBeUndefined();
    expect(
      resolveIngestLimits({ INGEST_COUNTRY_QUOTAS: "DE=0.5, CA=0.5" }).countryShares,
    ).toEqual({ DE: 0.5, CA: 0.5 });
  });
});

describe("computeCountryTargets", () => {
  it("turns the configured shares into per-country targets with a 50/50 split", () => {
    const targets = computeCountryTargets(1000, {
      DE: 0.25,
      CA: 0.25,
      NL: 0.2,
      IE: 0.1,
      GB: 0.1,
      AE: 0.05,
      SA: 0.05,
    });

    expect(targets.get("DE")).toEqual({ total: 250, remote: 125, nonRemote: 125 });
    expect(targets.get("CA")).toEqual({ total: 250, remote: 125, nonRemote: 125 });
    expect(targets.get("NL")).toEqual({ total: 200, remote: 100, nonRemote: 100 });
    expect(targets.get("IE")).toEqual({ total: 100, remote: 50, nonRemote: 50 });
    expect(targets.get("GB")).toEqual({ total: 100, remote: 50, nonRemote: 50 });
    expect(targets.get("AE")).toEqual({ total: 50, remote: 25, nonRemote: 25 });
    expect(targets.get("SA")).toEqual({ total: 50, remote: 25, nonRemote: 25 });
    expect(targets.get("QA")).toBeUndefined();
    expect([...targets.values()].reduce((sum, target) => sum + target.total, 0)).toBe(1000);
  });

  it("uses largest-remainder rounding so targets still sum to the total", () => {
    const targets = computeCountryTargets(100, { DE: 1 / 3, CA: 1 / 3, NL: 1 / 3 });
    expect([...targets.values()].reduce((sum, target) => sum + target.total, 0)).toBe(100);
  });
});

describe("IngestBudget", () => {
  it("caps each country independently in legacy mode", () => {
    const budget = new IngestBudget({ maxTotal: 1000, maxPerCountry: 3 });

    budget.record("DE");
    budget.record("DE");
    budget.record("DE");

    expect(budget.count("DE")).toBe(3);
    expect(budget.countryAtLimit("DE")).toBe(true);
    expect(budget.canAccept("DE")).toBe(false);
    expect(budget.canAccept("FR")).toBe(true);
  });

  it("stops everything once the total cap is reached", () => {
    const budget = new IngestBudget({ maxTotal: 2, maxPerCountry: 100 });

    budget.record("DE");
    budget.record("FR");

    expect(budget.totalReached).toBe(true);
    expect(budget.canAccept("DE")).toBe(false);
    expect(budget.canAccept("NL")).toBe(false);
  });

  it("counts per country across sources and snapshots the result", () => {
    const budget = new IngestBudget({ maxTotal: 100, maxPerCountry: 2 });

    budget.record("de");
    budget.record("DE");
    budget.recordSkipped(4);

    const snapshot = budget.snapshot();
    expect(snapshot.total).toBe(2);
    expect(snapshot.skipped).toBe(4);
    expect(snapshot.perCountry).toEqual({ DE: 2 });
    expect(snapshot.countriesAtLimit).toEqual(["DE"]);
  });

  it("stops remote jobs at the remote quota while the generic sweep keeps its budget (legacy)", () => {
    const budget = new IngestBudget({ maxTotal: 100, maxPerCountry: 10, maxRemotePerCountry: 3 });

    budget.record("DE", true);
    budget.record("DE", true);
    budget.record("DE", true);

    expect(budget.remoteCount("DE")).toBe(3);
    expect(budget.remoteAtLimit("DE")).toBe(true);
    // Remote is capped, but the generic sweep may keep filling the country budget.
    expect(budget.canAccept("DE", true)).toBe(false);
    expect(budget.canAccept("DE", false)).toBe(true);
  });

  it("defaults the remote quota to half the country cap in legacy mode", () => {
    const budget = new IngestBudget({ maxTotal: 100, maxPerCountry: 8 });
    expect(budget.maxRemotePerCountry).toBe(4);
    expect(budget.snapshot().remoteCountriesAtLimit).toEqual([]);
  });

  it("uses per-country targets and a 50/50 remote split in share mode", () => {
    const budget = new IngestBudget({
      maxTotal: 1000,
      maxPerCountry: 100,
      countryShares: { DE: 0.25, CA: 0.25, NL: 0.2, IE: 0.1, GB: 0.1, AE: 0.05, SA: 0.05 },
      remoteShare: 0.5,
    });

    expect(budget.usesCountryShares).toBe(true);
    expect(budget.countryTarget("DE")).toBe(250);
    expect(budget.remoteTarget("DE")).toBe(125);
    expect(budget.nonRemoteTarget("DE")).toBe(125);
    expect(budget.countryTarget("NL")).toBe(200);
    expect(budget.countryTarget("AE")).toBe(50);
    // Countries absent from the shares are disabled (target 0).
    expect(budget.countryTarget("QA")).toBe(0);
    expect(budget.countryAtLimit("QA")).toBe(true);
    expect(budget.canAccept("QA")).toBe(false);
    expect(budget.canAccept("DE")).toBe(true);
  });

  it("caps the remote and non-remote halves independently in share mode", () => {
    const budget = new IngestBudget({
      maxTotal: 10,
      maxPerCountry: 100,
      countryShares: { DE: 1 },
      remoteShare: 0.5,
    });

    for (let i = 0; i < 5; i += 1) budget.record("DE", false);
    expect(budget.nonRemoteCount("DE")).toBe(5);
    expect(budget.nonRemoteAtLimit("DE")).toBe(true);
    expect(budget.canAccept("DE", false)).toBe(false);
    expect(budget.canAccept("DE", true)).toBe(true);

    for (let i = 0; i < 5; i += 1) budget.record("DE", true);
    expect(budget.remoteCount("DE")).toBe(5);
    expect(budget.canAccept("DE", true)).toBe(false);
    expect(budget.countryAtLimit("DE")).toBe(true);
  });

  it("exposes the configured targets in the snapshot", () => {
    const budget = new IngestBudget({
      maxTotal: 100,
      maxPerCountry: 100,
      countryShares: { DE: 1 },
      remoteShare: 0.5,
    });

    expect(budget.snapshot().targets).toEqual({
      DE: { total: 100, remote: 50, nonRemote: 50 },
    });
  });
});
