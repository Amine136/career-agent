import type { SourceJob } from "../../src/core/types.js";

export function makeSourceJob(overrides: Partial<SourceJob> = {}): SourceJob {
  return {
    source: "test",
    sourceJobId: "1",
    url: "https://example.com/jobs/1",
    title: "AI Engineer",
    company: "Acme GmbH",
    countryCode: "DE",
    city: "Berlin",
    region: "Berlin, Germany",
    remote: false,
    employmentTypeRaw: null,
    seniority: null,
    experienceRequirement: null,
    description: null,
    snippet: null,
    language: null,
    postedAt: "2026-09-10",
    raw: {},
    ...overrides,
  };
}
