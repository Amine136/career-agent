import { describe, expect, it } from "vitest";
import { INDEED_CATEGORY_QUERIES } from "../config/index.js";
import { shouldFetchNextPage } from "../src/ingest/indeed.js";
import { buildLinkedInTasks } from "../src/ingest/linkedin.js";
import { orderSources } from "../src/scheduler/index.js";

describe("LinkedIn task fairness", () => {
  it("runs the remote pass before the generic sweep, round-robin across countries", () => {
    const tasks = buildLinkedInTasks({ countries: ["DE", "CA", "AU"] });

    // Depth 0 of the remote block: each country's first query, in country order. The remote pass
    // searches remote-intent queries, not the plain titles.
    expect(tasks.slice(0, 3).map((t) => [t.country.iso, t.query, t.remoteOnly])).toEqual([
      ["DE", "Remote AI Engineer", true],
      ["CA", "Remote AI Engineer", true],
      ["AU", "Remote AI Engineer", true],
    ]);
    expect(tasks.filter((t) => t.remoteOnly).every((t) => t.query.startsWith("Remote "))).toBe(
      true,
    );

    // Every remote task precedes every generic task.
    const firstGeneric = tasks.findIndex((t) => !t.remoteOnly);
    const lastRemote = tasks.map((t) => t.remoteOnly).lastIndexOf(true);
    expect(lastRemote).toBeLessThan(firstGeneric);
  });

  it("interleaves countries round-robin within each pass so a budget-limited sweep stays balanced", () => {
    const tasks = buildLinkedInTasks({ countries: ["DE", "CA", "AU"] });

    const deSecond = tasks.findIndex(
      (t) => !t.remoteOnly && t.country.iso === "DE" && t.query === "Junior AI Engineer",
    );
    const auFirst = tasks.findIndex(
      (t) => !t.remoteOnly && t.country.iso === "AU" && t.query === "AI Engineer",
    );
    expect(auFirst).toBeLessThan(deSecond);
  });

  it("visits every enabled country once per query depth", () => {
    const tasks = buildLinkedInTasks({});
    const firstTwelve = tasks.slice(0, 12).map((t) => t.country.iso);
    expect(new Set(firstTwelve).size).toBe(12);
    expect(tasks.slice(0, 12).every((t) => t.remoteOnly)).toBe(true);
  });
});

describe("Indeed adaptive paging", () => {
  it("continues only when a page beats the accepted-job threshold", () => {
    expect(shouldFetchNextPage(6, 5)).toBe(true);
    expect(shouldFetchNextPage(5, 5)).toBe(false);
    expect(shouldFetchNextPage(0, 5)).toBe(false);
  });

  it("prioritises Machine Learning, AI, NLP Engineer, Data Science", () => {
    expect(INDEED_CATEGORY_QUERIES).toEqual([
      "Machine Learning",
      "AI",
      "NLP Engineer",
      "Data Science",
    ]);
  });
});

describe("scheduler source ordering", () => {
  it("runs the paid source before the free sweep and de-duplicates", () => {
    expect(orderSources(["linkedin", "indeed"])).toEqual(["indeed", "linkedin"]);
    expect(orderSources(["linkedin", "indeed", "linkedin"])).toEqual(["indeed", "linkedin"]);
    expect(orderSources(["linkedin", "custom", "indeed"])).toEqual([
      "indeed",
      "linkedin",
      "custom",
    ]);
  });
});
