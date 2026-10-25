import { describe, expect, it } from "vitest";
import {
  buildDedupeKey,
  detectEntryLevel,
  isExcludedTitle,
  normalizeEmploymentType,
  normalizeSourceJob,
  normalizeText,
  normalizeTitle,
} from "../src/core/normalize.js";
import { makeSourceJob } from "./helpers/fixtures.js";

describe("normalizeText / normalizeTitle", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizeText("  AI  Engineer,  Berlin! ")).toBe("ai engineer berlin");
  });

  it("removes German gender markers", () => {
    expect(normalizeTitle("Machine Learning Engineer (m/w/d)")).toBe(
      "machine learning engineer",
    );
  });

  it("keeps unicode letters for localized titles", () => {
    expect(normalizeText("AI-ingenjör")).toBe("ai ingenjör");
  });
});

describe("employment type", () => {
  it("maps known types to the allowed set", () => {
    expect(normalizeEmploymentType("Full-time")).toBe("Full-time");
    expect(normalizeEmploymentType("Part-time")).toBe("Part-time");
    expect(normalizeEmploymentType("Werkstudent")).toBe("Working student");
    expect(normalizeEmploymentType("Praktikum")).toBe("Internship");
    expect(normalizeEmploymentType("Festanstellung")).toBe("Full-time");
  });

  it("returns null for unrecognized types", () => {
    expect(normalizeEmploymentType("Contract")).toBeNull();
  });
});

describe("entry-level detection", () => {
  it("accepts LinkedIn entry seniority", () => {
    expect(detectEntryLevel(makeSourceJob({ seniority: "Entry level" }))).toBe(true);
  });

  it("accepts entry tokens in title", () => {
    expect(detectEntryLevel(makeSourceJob({ title: "Werkstudent AI" }))).toBe(true);
    expect(detectEntryLevel(makeSourceJob({ title: "Graduate ML Engineer" }))).toBe(true);
  });

  it("rejects a role with no entry signal", () => {
    expect(detectEntryLevel(makeSourceJob({ title: "AI Engineer", description: "5+ years" }))).toBe(
      false,
    );
  });

  it("excludes senior titles unless they carry an entry token", () => {
    expect(isExcludedTitle("Senior AI Engineer")).toBe(true);
    expect(isExcludedTitle("Senior AI Engineer (Junior)")).toBe(false);
    expect(isExcludedTitle("Lead ML Engineer")).toBe(true);
  });
});

describe("normalizeSourceJob", () => {
  it("computes normalized title, type and weight", () => {
    const normalized = normalizeSourceJob(
      makeSourceJob({ title: "Junior AI Engineer (m/w/d)", employmentTypeRaw: "Full-time" }),
    );
    expect(normalized.titleNormalized).toBe("junior ai engineer");
    expect(normalized.employmentType).toBe("Full-time");
    expect(normalized.jobTypeWeight).toBe(5);
    expect(normalized.entryLevel).toBe(true);
  });

  it("infers working student from the description when type is missing", () => {
    const normalized = normalizeSourceJob(
      makeSourceJob({ description: "We are hiring a working student for our AI team." }),
    );
    expect(normalized.employmentType).toBe("Working student");
    expect(normalized.jobTypeWeight).toBe(2);
  });

  it("marks a senior role as not entry-level", () => {
    const normalized = normalizeSourceJob(makeSourceJob({ title: "Senior Data Scientist" }));
    expect(normalized.entryLevel).toBe(false);
  });

  it("builds a stable fuzzy dedupe key", () => {
    const key = buildDedupeKey("acme gmbh", "ai engineer", "DE", "Berlin");
    expect(key).toBe("acme gmbh|ai engineer|DE|berlin");
  });
});
