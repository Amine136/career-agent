import { describe, expect, it, vi } from "vitest";
import { countryByIso } from "../config/index.js";
import { parseRelativeDate, toIsoDate } from "../src/sources/dates.js";
import {
  extractIndeedJobCards,
  indeedSearchUrl,
  parseIndeedHtml,
} from "../src/sources/indeed-brightdata.js";
import {
  fetchLinkedInPage,
  parseLinkedInDetailHtml,
  parseLinkedInSearchHtml,
} from "../src/sources/linkedin.js";

const DE = countryByIso("DE")!;

const LINKEDIN_SEARCH_HTML = `
<ul>
  <li>
    <div class="base-card job-search-card" data-entity-urn="urn:li:jobPosting:12345">
      <a class="base-card__full-link" href="https://de.linkedin.com/jobs/view/ai-engineer-at-acme-12345?trk=public">view</a>
      <h3 class="base-search-card__title"> AI Engineer </h3>
      <a class="hidden-nested-link" href="/company/acme">Acme GmbH</a>
      <span class="job-search-card__location">Berlin, Germany</span>
      <time class="job-search-card__listdate--new" datetime="2026-09-10">2 days ago</time>
    </div>
  </li>
</ul>`;

const LINKEDIN_DETAIL_HTML = `
<div class="top-card-layout__title">AI Engineer</div>
<a class="topcard__org-name-link">Acme GmbH</a>
<span class="topcard__flavor--bullet">Berlin, Germany</span>
<ul>
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader">Seniority level</h3>
    <span class="description__job-criteria-text">Entry level</span>
  </li>
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader">Employment type</h3>
    <span class="description__job-criteria-text">Full-time</span>
  </li>
</ul>
<div class="show-more-less-html__markup">Build AI systems.</div>`;

const INDEED_HTML = `
<div class="job_seen_beacon">
  <a data-jk="abc123" class="jcs-JobTitle" title="Machine Learning Engineer">
    <h2 class="jobTitle"><span>Machine Learning Engineer</span></h2>
  </a>
  <span data-testid="company-name">Acme GmbH</span>
  <div data-testid="text-location">Munich, Germany</div>
  <div data-testid="job-snippet">Great entry level role for recent graduates.</div>
  <span data-testid="myJobsStateDate">1 day ago</span>
</div>`;

// Real Indeed SERPs embed the job list in `window.mosaic.providerData`; the card DOM no longer
// carries the title or posting date, so this model is the primary parse path.
const INDEED_MODEL_HTML = `
<script>
window.mosaic.providerData={};
window.mosaic.providerData["mosaic-provider-jobcards"]={"metaData":{"mosaicProviderJobCardsModel":{"results":[
  {"jobkey":"model-1","displayTitle":"Junior AI Engineer","company":"Acme GmbH","formattedLocation":"Berlin","formattedRelativeTime":"vor 2 Tagen","createDate":1789035370657,"jobTypes":["Vollzeit","Festanstellung"],"snippet":"<ul><li>Entry level role for recent graduates.</li></ul>","remoteLocation":false,"expired":false,"country":"DE"},
  {"jobkey":"model-2","displayTitle":"Internship – Surgical Robotics","company":"ZEISS","formattedLocation":"Karlsruhe","formattedRelativeTime":"vor 1 Tag","jobTypes":[],"remoteLocation":true,"expired":false,"country":"DE"},
  {"jobkey":"model-3","displayTitle":"Expired Role","company":"Ghost GmbH","formattedRelativeTime":"vor 2 Tagen","expired":true,"country":"DE"}
]}}};
</script>`;


describe("LinkedIn parsing", () => {
  it("parses search cards", () => {
    const jobs = parseLinkedInSearchHtml(LINKEDIN_SEARCH_HTML, DE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "linkedin",
      sourceJobId: "12345",
      url: "https://de.linkedin.com/jobs/view/ai-engineer-at-acme-12345",
      title: "AI Engineer",
      company: "Acme GmbH",
      countryCode: "DE",
      city: "Berlin",
      postedAt: "2026-09-10",
    });
  });

  it("parses detail criteria", () => {
    const detail = parseLinkedInDetailHtml(LINKEDIN_DETAIL_HTML);
    expect(detail.seniority).toBe("Entry level");
    expect(detail.employmentTypeRaw).toBe("Full-time");
    expect(detail.description).toBe("Build AI systems.");
  });

  it("uses the remote filter as a hint but re-verifies remote from the posting text", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes("jobPosting") ? LINKEDIN_DETAIL_HTML : LINKEDIN_SEARCH_HTML;
      return new Response(body, { status: 200 });
    });
    try {
      const page = await fetchLinkedInPage({
        country: DE,
        query: "AI Engineer",
        start: 0,
        remoteOnly: true,
        delayMs: 0,
      });
      expect(urls[0]).toContain("f_WT=2");
      // Every job type except Internship (I) is requested.
      expect(urls[0]).toContain("f_JT=F%2CP%2CC%2CT%2CV");
      // "Berlin, Germany" + "Build AI systems." carries no arrangement, so a remote-filtered hit
      // that is actually on-site must NOT be stored as remote.
      expect(page.jobs[0]!.remote).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still flags a remote-filtered hit whose posting text says remote", async () => {
    const remoteDetail = LINKEDIN_DETAIL_HTML.replace(
      "Build AI systems.",
      "This is a fully remote position.",
    );
    vi.stubGlobal("fetch", async (input: unknown) =>
      new Response(String(input).includes("jobPosting") ? remoteDetail : LINKEDIN_SEARCH_HTML, {
        status: 200,
      }),
    );
    try {
      const page = await fetchLinkedInPage({
        country: DE,
        query: "AI Engineer",
        start: 0,
        remoteOnly: true,
        delayMs: 0,
      });
      expect(page.jobs[0]!.remote).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits the remote filter and keeps heuristic detection on the generic pass", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      urls.push(String(input));
      return new Response(LINKEDIN_SEARCH_HTML, { status: 200 });
    });
    try {
      const page = await fetchLinkedInPage({
        country: DE,
        query: "AI Engineer",
        start: 0,
        fetchDetails: false,
      });
      expect(urls[0]).not.toContain("f_WT");
      expect(page.jobs[0]!.remote).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Indeed parsing", () => {
  it("adds Indeed's remote attribute only on remote searches", () => {
    const generic = indeedSearchUrl(DE, "AI");
    expect(generic).not.toContain("sc=");
    expect(generic).toContain("fromage=3");

    const remote = indeedSearchUrl(DE, "AI", 0, true);
    expect(remote).toContain("sc=");
    expect(remote).toContain("DSQF7");
  });

  it("parses Bright Data HTML cards", () => {
    const jobs = parseIndeedHtml(INDEED_HTML, DE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "indeed",
      sourceJobId: "abc123",
      url: "https://de.indeed.com/viewjob?jk=abc123",
      title: "Machine Learning Engineer",
      company: "Acme GmbH",
      city: "Munich",
    });
    expect(jobs[0]!.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("deduplicates repeated data-jk cards", () => {
    const jobs = parseIndeedHtml(`${INDEED_HTML}${INDEED_HTML}`, DE);
    expect(jobs).toHaveLength(1);
  });

  it("extracts the embedded job-card model", () => {
    const cards = extractIndeedJobCards(INDEED_MODEL_HTML);
    expect(cards).toHaveLength(3);
    expect(cards[0]!.jobkey).toBe("model-1");
  });

  it("parses the embedded model, skipping expired cards", () => {
    const jobs = parseIndeedHtml(INDEED_MODEL_HTML, DE);
    expect(jobs).toHaveLength(2);
    const junior = jobs.find((j) => j.sourceJobId === "model-1")!;
    expect(junior).toMatchObject({
      source: "indeed",
      title: "Junior AI Engineer",
      company: "Acme GmbH",
      city: "Berlin",
      employmentTypeRaw: "Vollzeit, Festanstellung",
      remote: false,
      snippet: "Entry level role for recent graduates.",
    });
    expect(junior.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const internship = jobs.find((j) => j.sourceJobId === "model-2")!;
    expect(internship.remote).toBe(true);
    expect(internship.employmentTypeRaw).toBeNull();
    expect(jobs.some((j) => j.sourceJobId === "model-3")).toBe(false);
  });
});

describe("date helpers", () => {
  it("parses absolute dates", () => {
    expect(toIsoDate("2026-09-10T10:00:00Z")).toBe("2026-09-10");
  });

  it("parses relative dates", () => {
    const now = new Date("2026-09-12T12:00:00Z");
    expect(parseRelativeDate("3 days ago", now)).toBe("2026-09-09");
    expect(parseRelativeDate("Just posted", now)).toBe("2026-09-12");
    expect(parseRelativeDate("Yesterday", now)).toBe("2026-09-11");
    expect(parseRelativeDate("nonsense", now)).toBeNull();
  });
});
