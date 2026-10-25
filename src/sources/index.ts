import type { Country } from "../../config/index.js";
import type { SourceJob } from "../core/types.js";
import { fetchIndeedJobs } from "./indeed-brightdata.js";
import { fetchLinkedInJobs } from "./linkedin.js";

export interface SourceFetchContext {
  country: Country;
  query: string;
  pages?: number;
  signal?: AbortSignal;
}

export interface SourceAdapter {
  name: string;
  fetchJobs(ctx: SourceFetchContext): Promise<SourceJob[]>;
}

export const linkedInAdapter: SourceAdapter = {
  name: "linkedin",
  fetchJobs: (ctx) =>
    fetchLinkedInJobs({
      country: ctx.country,
      query: ctx.query,
      pages: ctx.pages,
      signal: ctx.signal,
    }),
};

export const indeedAdapter: SourceAdapter = {
  name: "indeed",
  fetchJobs: (ctx) =>
    fetchIndeedJobs({
      country: ctx.country,
      query: ctx.query,
      pages: ctx.pages,
      signal: ctx.signal,
    }),
};

export const SOURCE_ADAPTERS: Record<string, SourceAdapter> = {
  linkedin: linkedInAdapter,
  indeed: indeedAdapter,
};
