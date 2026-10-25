import { describe, expect, it } from "vitest";
import { applyHardFilters, daysSince } from "../src/core/filters.js";
import { normalizeSourceJob } from "../src/core/normalize.js";
import { makeSourceJob } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-12T12:00:00Z");

function evaluate(overrides: Parameters<typeof makeSourceJob>[0]) {
  return applyHardFilters(normalizeSourceJob(makeSourceJob(overrides)), NOW);
}

describe("daysSince", () => {
  it("counts whole calendar days", () => {
    expect(daysSince("2026-09-12", NOW)).toBe(0);
    expect(daysSince("2026-09-09", NOW)).toBe(3);
    expect(daysSince("2026-09-01", NOW)).toBe(11);
  });
});

describe("applyHardFilters", () => {
  it("accepts a fresh entry-level job", () => {
    const result = evaluate({ title: "Junior AI Engineer", postedAt: "2026-09-10" });
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects jobs older than 3 days", () => {
    const result = evaluate({ title: "Junior AI Engineer", postedAt: "2026-09-01" });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("older_than_3_days");
  });

  it("rejects jobs without a posted date", () => {
    const result = evaluate({ title: "Junior AI Engineer", postedAt: null });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("missing_posted_at");
  });

  it("rejects non entry-level jobs", () => {
    const result = evaluate({ title: "Senior AI Engineer", postedAt: "2026-09-11" });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("not_entry_level");
  });

  it("rejects an explicitly disallowed employment type", () => {
    const result = evaluate({
      title: "Junior AI Engineer",
      postedAt: "2026-09-11",
      employmentTypeRaw: "Contract",
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("job_type_not_allowed");
  });

  it("accepts a recognized employment type", () => {
    const result = evaluate({
      title: "Junior AI Engineer",
      postedAt: "2026-09-11",
      employmentTypeRaw: "Full-time",
    });
    expect(result.accepted).toBe(true);
  });

  it("rejects internships by title or declared type", () => {
    expect(evaluate({ title: "AI Engineering Intern", postedAt: "2026-09-11" }).reasons).toContain(
      "excluded_internship",
    );
    expect(evaluate({ title: "Data Science Praktikum", postedAt: "2026-09-11" }).reasons).toContain(
      "excluded_internship",
    );
    expect(evaluate({ title: "Stage Data Analyst", postedAt: "2026-09-11" }).reasons).toContain(
      "excluded_internship",
    );
    expect(
      evaluate({
        title: "AI Engineer",
        postedAt: "2026-09-11",
        employmentTypeRaw: "Internship",
      }).reasons,
    ).toContain("excluded_internship");
  });

  it("does not reject entry-level roles that merely contain 'intern' substrings", () => {
    expect(evaluate({ title: "Junior Internal Tools Engineer", postedAt: "2026-09-11" }).accepted).toBe(
      true,
    );
    expect(
      evaluate({ title: "Junior International Software Engineer", postedAt: "2026-09-11" }).accepted,
    ).toBe(true);
  });
});
