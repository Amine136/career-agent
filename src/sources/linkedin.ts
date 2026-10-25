import * as cheerio from "cheerio";
import type { Country } from "../../config/index.js";
import { detectRemote } from "../core/remote.js";
import { sourceJobSchema, type SourceJob } from "../core/types.js";
import { toIsoDate } from "./dates.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

/**
 * LinkedIn job-type filter (`f_JT`) values, comma-separated: F=Full-time, P=Part-time,
 * C=Contract, T=Temporary, V=Volunteer. Internship (`I`) is deliberately omitted so internships
 * are not requested.
 */
export const LINKEDIN_JOB_TYPES = "F,P,C,T,V";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function cleanUrl(href: string): string {
  const withoutQuery = href.split("?")[0] ?? href;
  return withoutQuery.replace(/\/$/, "");
}

function firstLocationPart(location: string): string | null {
  const part = location.split(",")[0]?.trim();
  return part && part.length > 0 ? part : null;
}

/** Parse the job-card HTML fragment returned by the guest search endpoint. */
export function parseLinkedInSearchHtml(html: string, country: Country): SourceJob[] {
  const $ = cheerio.load(html);
  const jobs: SourceJob[] = [];

  $("[data-entity-urn]").each((_, el) => {
    const card = $(el);
    const urn = card.attr("data-entity-urn") ?? "";
    const idMatch = urn.match(/jobPosting:(\d+)/);
    const sourceJobId = idMatch?.[1];
    const href = card.find("a.base-card__full-link").attr("href");
    const title = card.find(".base-search-card__title").first().text().trim();
    const company = card.find(".hidden-nested-link").first().text().trim();
    const location = card.find(".job-search-card__location").first().text().trim();
    const dateEl = card.find('time[class*="job-search-card__listdate"]');
    const dateAttr = dateEl.attr("datetime");
    const dateText = dateEl.first().text().trim();

    if (!sourceJobId || !href || !title || !company) return;

    const parsed = sourceJobSchema.safeParse({
      source: "linkedin",
      sourceJobId,
      url: cleanUrl(href),
      title,
      company,
      countryCode: country.iso,
      city: firstLocationPart(location),
      region: location || null,
      remote: detectRemote({ location, title }),
      employmentTypeRaw: null,
      seniority: null,
      experienceRequirement: null,
      description: null,
      snippet: null,
      language: null,
      postedAt: toIsoDate(dateAttr ?? dateText),
      raw: { urn, location, date: dateAttr ?? dateText },
    });
    if (parsed.success) jobs.push(parsed.data);
  });

  return jobs;
}

function criteriaValue($: cheerio.CheerioAPI, label: string): string | null {
  let value: string | null = null;
  $(".description__job-criteria-item").each((_, el) => {
    const header = $(el).find(".description__job-criteria-subheader").text().trim().toLowerCase();
    if (header === label.toLowerCase()) {
      const text = $(el).find(".description__job-criteria-text").text().trim();
      value = text || null;
    }
  });
  return value;
}

export interface LinkedInDetail {
  title: string | null;
  company: string | null;
  location: string | null;
  seniority: string | null;
  employmentTypeRaw: string | null;
  description: string | null;
}

/** Parse a guest detail page for seniority, employment type and description. */
export function parseLinkedInDetailHtml(html: string): LinkedInDetail {
  const $ = cheerio.load(html);
  const location = $(".topcard__flavor--bullet").first().text().trim();
  return {
    title: $(".top-card-layout__title").first().text().trim() || null,
    company: $(".topcard__org-name-link").first().text().trim() || null,
    location: location || null,
    seniority: criteriaValue($, "Seniority level"),
    employmentTypeRaw: criteriaValue($, "Employment type"),
    description: $(".show-more-less-html__markup").first().text().trim() || null,
  };
}

async function fetchDetail(jobId: string, signal?: AbortSignal): Promise<LinkedInDetail> {
  const response = await fetch(`${DETAIL_URL}/${jobId}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`LinkedIn detail HTTP ${response.status}`);
  return parseLinkedInDetailHtml(await response.text());
}

async function searchPage(
  query: string,
  location: string,
  start: number,
  remoteOnly = false,
  signal?: AbortSignal,
): Promise<string> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("keywords", query);
  url.searchParams.set("location", location);
  url.searchParams.set("start", String(start));
  url.searchParams.set("f_TPR", "r259200"); // last 3 days
  url.searchParams.set("f_E", "2"); // Entry level
  // Ask for every job type except Internship (LinkedIn codes: F/P/C/T/V; I is internship). The
  // guest API often ignores filters, so internships are also rejected client-side in
  // applyHardFilters.
  url.searchParams.set("f_JT", LINKEDIN_JOB_TYPES);
  if (remoteOnly) url.searchParams.set("f_WT", "2"); // Remote workplace type
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`LinkedIn search HTTP ${response.status}`);
  return response.text();
}

/** Guest search page size (LinkedIn returns up to 25 cards per request). */
export const LINKEDIN_PAGE_SIZE = 25;

/** Parse one guest-search results page into source jobs (no detail enrichment). */
export async function fetchLinkedInSearchPage(
  country: Country,
  query: string,
  start: number,
  remoteOnly = false,
  signal?: AbortSignal,
): Promise<SourceJob[]> {
  const html = await searchPage(query, country.linkedinLocation, start, remoteOnly, signal);
  return parseLinkedInSearchHtml(html, country);
}

/** Fetch and (optionally) enrich a single search page. `cardCount` 0 means end of results. */
export async function fetchLinkedInPage(options: {
  country: Country;
  query: string;
  start: number;
  remoteOnly?: boolean;
  fetchDetails?: boolean;
  delayMs?: number;
  signal?: AbortSignal;
}): Promise<{ jobs: SourceJob[]; cardCount: number }> {
  const fetchDetails = options.fetchDetails ?? true;
  const remoteOnly = options.remoteOnly ?? false;
  const delayMs = options.delayMs ?? Number(process.env.LINKEDIN_REQUEST_DELAY_MS ?? 1500);
  const parsed = await fetchLinkedInSearchPage(
    options.country,
    options.query,
    options.start,
    remoteOnly,
    options.signal,
  );

  if (!fetchDetails) {
    return { jobs: parsed, cardCount: parsed.length };
  }

  const jobs: SourceJob[] = [];
  for (const card of parsed) {
    await sleep(delayMs);
    try {
      const detail = await fetchDetail(card.sourceJobId, options.signal);
      const detailTitle = detail.title ?? card.title;
      const detailLocation = detail.location ?? card.region;
      jobs.push({
        ...card,
        title: detailTitle,
        company: detail.company ?? card.company,
        region: detailLocation,
        city: firstLocationPart(detail.location ?? "") ?? card.city,
        // The remote-only search (`f_WT=2`) is a candidate hint, not ground truth: it regularly
        // returns on-site roles. Re-verify the stored flag from the posting text itself.
        remote: detectRemote({
          location: detailLocation,
          title: detailTitle,
          description: detail.description,
        }),
        seniority: detail.seniority,
        employmentTypeRaw: detail.employmentTypeRaw,
        description: detail.description,
        raw: { ...(card.raw as object), detail: { ...detail, description: undefined } },
      });
    } catch {
      // Keep card-level data when the detail request fails (partial failures allowed).
      jobs.push(card);
    }
  }
  return { jobs, cardCount: parsed.length };
}

export interface LinkedInFetchOptions {
  country: Country;
  query: string;
  pages?: number;
  remoteOnly?: boolean;
  fetchDetails?: boolean;
  delayMs?: number;
  signal?: AbortSignal;
}

export async function fetchLinkedInJobs(options: LinkedInFetchOptions): Promise<SourceJob[]> {
  const pages = options.pages ?? 1;
  const fetchDetails = options.fetchDetails ?? true;
  const delayMs = options.delayMs ?? Number(process.env.LINKEDIN_REQUEST_DELAY_MS ?? 1500);
  const jobs: SourceJob[] = [];

  for (let page = 0; page < pages; page += 1) {
    const { jobs: pageJobs, cardCount } = await fetchLinkedInPage({
      country: options.country,
      query: options.query,
      start: page * LINKEDIN_PAGE_SIZE,
      remoteOnly: options.remoteOnly,
      fetchDetails,
      delayMs,
      signal: options.signal,
    });
    if (cardCount === 0) break;
    jobs.push(...pageJobs);
    await sleep(delayMs);
  }

  return jobs;
}
