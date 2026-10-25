import { describe, expect, it } from "vitest";
import { detectRemote } from "../src/core/remote.js";

describe("detectRemote", () => {
  it("detects remote markers in the location or title", () => {
    expect(detectRemote({ location: "Berlin, Germany (Remote)" })).toBe(true);
    expect(detectRemote({ location: "Remote", title: "AI Engineer" })).toBe(true);
    expect(detectRemote({ title: "Werkstudent Homeoffice (m/w/d)" })).toBe(true);
    expect(detectRemote({ location: "München", title: "Fully Remote ML Engineer" })).toBe(true);
  });

  it("ignores a plain on-site location", () => {
    expect(detectRemote({ location: "Berlin, Deutschland", title: "AI Engineer" })).toBe(false);
    expect(detectRemote({})).toBe(false);
  });

  it("only trusts strong phrases in the description", () => {
    expect(detectRemote({ description: "We offer a fully remote position." })).toBe(true);
    expect(detectRemote({ description: "Homeoffice möglich, 2 Tage pro Woche." })).toBe(true);
    // A bare or occasional mention of "remote" in the body is ambiguous (hybrid) and not enough.
    expect(detectRemote({ description: "Occasional remote work is possible." })).toBe(false);
    expect(detectRemote({ description: "Some tasks can be done remote." })).toBe(false);
  });

  it("lets negations veto a match", () => {
    expect(detectRemote({ location: "Berlin", description: "This is not a remote role." })).toBe(
      false,
    );
    expect(detectRemote({ location: "Berlin (Remote work not possible)" })).toBe(false);
    expect(detectRemote({ title: "Onsite only", description: "homeoffice" })).toBe(false);
  });

  it("does not treat a role with no stated arrangement as remote", () => {
    // Lely "Data Analysis & Advisory" (NL): surfaced by LinkedIn's remote filter, but the posting
    // only describes a physical campus — it never mentions remote, hybrid or on-site.
    expect(
      detectRemote({
        location: "Maassluis, South Holland, Netherlands",
        title: "Internship: Data Analysis & Advisory",
        description:
          "We still do this from our Campus in Maassluis, the building with the highest " +
          "achievable sustainability standards in the Netherlands, while also operating around " +
          "the world. You will work within the Continuous Development team.",
      }),
    ).toBe(false);
  });
});
