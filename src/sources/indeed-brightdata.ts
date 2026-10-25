import * as cheerio from "cheerio";
import type { Country } from "../../config/index.js";
import { detectRemote } from "../core/remote.js";
import { sourceJobSchema, type SourceJob } from "../core/types.js";
import { parseRelativeDate, toIsoDate } from "./dates.js";

const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";
const JOB_CARDS_MARKER = 'providerData["mosaic-provider-jobcards"]=';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstLocationPart(location: string): string | null {
  const part = location.split(",")[0]?.trim();
  return part && part.length > 0 ? part : null;
}

export function indeedSearchUrl(
  country: Country,
  query: string,
  start = 0,
  remoteOnly = false,
): string {
  const url = new URL(`https://${country.indeedDomain}/jobs`);
  url.searchParams.set("q", query);
  url.searchParams.set("l", country.name);
  url.searchParams.set("fromage", "3");
  url.searchParams.set("sort", "date");
  if (start > 0) url.searchParams.set("start", String(start));
  // Indeed's "Remote" search attribute (sc=0kf:attr(DSQF7);). A hint only: the stored `remote`
  // flag is still re-verified from the posting text in `normalizeSourceJob`.
  if (remoteOnly) url.searchParams.set("sc", "0kf:attr(DSQF7);");
  return url.toString();
}

/**
 * A job card as embedded by Indeed in `window.mosaic.providerData["mosaic-provider-jobcards"]`.
 * Indeed renders the SERP client-side; the JSON model is the authoritative, stable source and
 * also carries the posting date (`createDate` / `formattedRelativeTime`), which the card DOM no
 * longer exposes.
 */
export interface IndeedJobCard {
  jobkey?: string;
  displayTitle?: string;
  title?: string;
  company?: string;
  formattedLocation?: string;
  formattedRelativeTime?: string;
  createDate?: number;
  jobTypes?: string[];
  snippet?: string;
  remoteLocation?: boolean;
  expired?: boolean;
  country?: string;
}

/** Extract the embedded job-card model from the SERP HTML (brace-balanced JSON slice). */
export function extractIndeedJobCards(html: string): IndeedJobCard[] {
  const markerIndex = html.indexOf(JOB_CARDS_MARKER);
  if (markerIndex < 0) return [];
  const start = markerIndex + JOB_CARDS_MARKER.length;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return [];

  try {
    const parsed = JSON.parse(html.slice(start, end)) as {
      metaData?: { mosaicProviderJobCardsModel?: { results?: unknown } };
    };
    const results = parsed.metaData?.mosaicProviderJobCardsModel?.results;
    return Array.isArray(results) ? (results as IndeedJobCard[]) : [];
  } catch {
    return [];
  }
}

function stripHtml(value: string): string {
  return cleanText(cheerio.load(value).text());
}

/** Convert the embedded job-card model into source jobs. */
export function parseIndeedModel(cards: IndeedJobCard[], country: Country): SourceJob[] {
  const jobs: SourceJob[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    const jk = card.jobkey?.trim();
    const title = cleanText(card.displayTitle ?? card.title ?? "");
    const company = cleanText(card.company ?? "");
    if (!jk || !title || !company || card.expired || seen.has(jk)) continue;
    seen.add(jk);

    const location = cleanText(card.formattedLocation ?? "");
    const jobTypes = Array.isArray(card.jobTypes) ? card.jobTypes.filter(Boolean) : [];
    const postedAt =
      toIsoDate(card.createDate ? new Date(card.createDate).toISOString() : null) ??
      (card.formattedRelativeTime ? parseRelativeDate(card.formattedRelativeTime) : null);

    const parsed = sourceJobSchema.safeParse({
      source: "indeed",
      sourceJobId: jk,
      url: `https://${country.indeedDomain}/viewjob?jk=${jk}`,
      title,
      company,
      countryCode: (card.country ?? country.iso).toUpperCase(),
      city: firstLocationPart(location),
      region: location || null,
      remote:
        card.remoteLocation === true ||
        detectRemote({ location, title, description: card.snippet }),
      employmentTypeRaw: jobTypes.length > 0 ? jobTypes.join(", ") : null,
      seniority: null,
      experienceRequirement: null,
      description: null,
      snippet: card.snippet ? stripHtml(card.snippet) : null,
      language: null,
      postedAt,
      raw: {
        jk,
        location,
        formattedRelativeTime: card.formattedRelativeTime,
        createDate: card.createDate,
        jobTypes,
      },
    });
    if (parsed.success) jobs.push(parsed.data);
  }

  return jobs;
}

/** Parse Indeed search-results HTML served through Bright Data Web Unlocker. */
export function parseIndeedHtml(html: string, country: Country): SourceJob[] {
  // Preferred: the embedded JSON model (stable fields incl. posting date).
  const fromModel = parseIndeedModel(extractIndeedJobCards(html), country);
  if (fromModel.length > 0) return fromModel;

  // Fallback: parse the server-rendered cards directly.
  const $ = cheerio.load(html);
  const jobs: SourceJob[] = [];
  const seen = new Set<string>();

  $("[data-jk]").each((_, el) => {
    const node = $(el);
    const jk = node.attr("data-jk");
    if (!jk || seen.has(jk)) return;
    seen.add(jk);

    const card = node.closest("div.job_seen_beacon, td.resultContent, li, div.cardOutline").first();
    const scope = card.length > 0 ? card : node;

    const title =
      cleanText(node.find("h3.jobTitle span[title]").first().attr("title") ?? "") ||
      cleanText(
        scope.find("h3.jobTitle span, h2.jobTitle span, h3.jobTitle, h2.jobTitle").first().text(),
      ) ||
      cleanText(node.find("h2 span, h3 span").first().text()) ||
      cleanText(node.attr("aria-label") ?? "").replace(/^alle details zu\s+/i, "") ||
      cleanText(node.text()) ||
      cleanText(node.attr("title") ?? "");
    const company = cleanText(scope.find('[data-testid="company-name"]').first().text());
    const location = cleanText(scope.find('[data-testid="text-location"]').first().text());
    const snippet = cleanText(
      scope.find('[data-testid="job-snippet"], [data-testid="belowJobSnippet"]').first().text(),
    );
    const dateText = cleanText(
      scope
        .find(
          '[data-testid="myJobsStateDate"], [data-testid="job-search-card-date-range"], span.date, .date',
        )
        .first()
        .text(),
    );

    if (!title || !company) return;

    const parsed = sourceJobSchema.safeParse({
      source: "indeed",
      sourceJobId: jk,
      url: `https://${country.indeedDomain}/viewjob?jk=${jk}`,
      title,
      company,
      countryCode: country.iso,
      city: firstLocationPart(location),
      region: location || null,
      remote: detectRemote({ location, title, description: snippet }),
      employmentTypeRaw: null,
      seniority: null,
      experienceRequirement: null,
      description: null,
      snippet: snippet || null,
      language: null,
      postedAt: toIsoDate(dateText),
      raw: { jk, location, snippet, dateText },
    });
    if (parsed.success) jobs.push(parsed.data);
  });

  return jobs;
}

export interface IndeedFetchOptions {
  country: Country;
  query: string;
  pages?: number;
  remoteOnly?: boolean;
  delayMs?: number;
  signal?: AbortSignal;
}

async function brightDataFetch(
  targetUrl: string,
  countryIso: string,
  signal?: AbortSignal,
): Promise<string> {
  const token =
    process.env.BRIGHTDATA_TOKEN ??
    process.env.BRIGHT_DATA_API ??
    process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_ZONE ?? "web_unlocker1";
  if (!token) {
    throw new Error(
      "Bright Data token is not set (BRIGHTDATA_TOKEN or BRIGHT_DATA_API); skipping Indeed source.",
    );
  }
  const response = await fetch(BRIGHTDATA_REQUEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      zone,
      url: targetUrl,
      format: "raw",
      country: countryIso.toLowerCase(),
    }),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    throw new Error(`Bright Data request failed with HTTP ${response.status}`);
  }
  return response.text();
}

/** Indeed search page size (10 cards per request). */
export const INDEED_PAGE_SIZE = 10;

/** Fetch one Indeed results page through Bright Data (1 billable request) and parse it. */
export async function fetchIndeedPage(
  country: Country,
  query: string,
  start: number,
  signal?: AbortSignal,
  remoteOnly = false,
): Promise<SourceJob[]> {
  const targetUrl = indeedSearchUrl(country, query, start, remoteOnly);
  const html = await brightDataFetch(targetUrl, country.iso, signal);
  return parseIndeedHtml(html, country);
}

export async function fetchIndeedJobs(options: IndeedFetchOptions): Promise<SourceJob[]> {
  const pages = options.pages ?? 1;
  const delayMs = options.delayMs ?? 1000;
  const jobs: SourceJob[] = [];

  for (let page = 0; page < pages; page += 1) {
    const parsed = await fetchIndeedPage(
      options.country,
      options.query,
      page * INDEED_PAGE_SIZE,
      options.signal,
      options.remoteOnly,
    );
    if (parsed.length === 0) break;
    jobs.push(...parsed);
    await sleep(delayMs);
  }

  return jobs;
}
