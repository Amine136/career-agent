import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPANY_CAP,
  DEFAULT_COMPANY_WINDOW_DAYS,
  CompanyGuard,
  resolveCompanyLimits,
} from "../src/ingest/company-guard.js";

describe("resolveCompanyLimits", () => {
  it("defaults to 10 jobs / 10 days with the generic-name exemptions", () => {
    const limits = resolveCompanyLimits({});
    expect(limits.cap).toBe(DEFAULT_COMPANY_CAP);
    expect(limits.windowDays).toBe(DEFAULT_COMPANY_WINDOW_DAYS);
    expect(limits.dryRun).toBe(false);
    expect(limits.exemptNames).toContain("confidential");
    expect(limits.exemptTokens).toContain("recruit");
  });

  it("reads overrides, clamps the window and supports turning the guard off", () => {
    expect(resolveCompanyLimits({ INGEST_COMPANY_CAP: "3" }).cap).toBe(3);
    expect(resolveCompanyLimits({ INGEST_COMPANY_CAP: "off" }).cap).toBe(0);
    expect(resolveCompanyLimits({ INGEST_COMPANY_CAP: "0" }).cap).toBe(0);
    expect(resolveCompanyLimits({ INGEST_COMPANY_CAP: "nope" }).cap).toBe(DEFAULT_COMPANY_CAP);
    expect(resolveCompanyLimits({ INGEST_COMPANY_WINDOW_DAYS: "30" }).windowDays).toBe(30);
    expect(resolveCompanyLimits({ INGEST_COMPANY_WINDOW_DAYS: "0" }).windowDays).toBe(1);
    expect(resolveCompanyLimits({ INGEST_COMPANY_DRY_RUN: "true" }).dryRun).toBe(true);
    expect(resolveCompanyLimits({ INGEST_COMPANY_DRY_RUN: "no" }).dryRun).toBe(false);
    expect(
      resolveCompanyLimits({ INGEST_COMPANY_CAP_EXEMPT: "acme, Globex" }).exemptNames,
    ).toContain("globex");
  });
});

describe("CompanyGuard", () => {
  it("caps a company once its window count reaches the cap", () => {
    const guard = new CompanyGuard({ cap: 2, windowDays: 10 }, new Map([["acme", 1]]));

    expect(guard.count("Acme")).toBe(1);
    expect(guard.remaining("Acme")).toBe(1);
    expect(guard.atCap("Acme")).toBe(false);
    expect(guard.shouldSkip("Acme")).toBe(false);

    guard.record("ACME");

    expect(guard.count("acme")).toBe(2);
    expect(guard.atCap("Acme")).toBe(true);
    expect(guard.shouldSkip("Acme")).toBe(true);
    expect(guard.remaining("Acme")).toBe(0);
  });

  it("never caps generic names or staffing agencies", () => {
    const counts = new Map([
      ["confidential", 99],
      ["acme staffing", 99],
    ]);
    const guard = new CompanyGuard({ cap: 2, windowDays: 10 }, counts);

    expect(guard.atCap("Confidential")).toBe(false);
    expect(guard.atCap("ACME Staffing Ltd")).toBe(false);
    // Recording an exempt company does not accumulate counts either.
    guard.record("Confidential");
    expect(guard.count("Confidential")).toBe(99);
  });

  it("records skips only when the company was at its cap", () => {
    const guard = new CompanyGuard({ cap: 2, windowDays: 10 }, new Map([["acme", 2]]));

    guard.recordSkipped("Acme");
    guard.recordSkipped("Other");
    guard.recordSkipped("Confidential");

    expect(guard.snapshot().skipped).toBe(1);
    expect(guard.snapshot().cappedCompanies).toEqual(["acme"]);
  });

  it("counts would-be skips in dry-run mode without skipping", () => {
    const guard = new CompanyGuard({ cap: 1, windowDays: 10, dryRun: true }, new Map([["acme", 1]]));

    expect(guard.atCap("Acme")).toBe(true);
    expect(guard.shouldSkip("Acme")).toBe(false);

    guard.recordSkipped("Acme");

    const snapshot = guard.snapshot();
    expect(snapshot.dryRun).toBe(true);
    expect(snapshot.skipped).toBe(1);
    expect(snapshot.cappedCompanies).toEqual(["acme"]);
  });

  it("is inert when disabled and reports a snapshot", () => {
    const guard = CompanyGuard.disabled();

    guard.record("Acme");
    guard.recordSkipped("Acme");

    expect(guard.enabled).toBe(false);
    expect(guard.count("Acme")).toBe(0);
    expect(guard.atCap("Acme")).toBe(false);
    expect(guard.remaining("Acme")).toBe(Number.POSITIVE_INFINITY);
    expect(guard.snapshot()).toEqual({
      enabled: false,
      dryRun: false,
      cap: 0,
      windowDays: 0,
      skipped: 0,
      cappedCompanies: [],
    });
  });
});
