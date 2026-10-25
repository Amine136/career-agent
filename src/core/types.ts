import { z } from "zod";
import type { JobType } from "../../config/job-types.js";

/** External ISO date (YYYY-MM-DD) or missing. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * A single posting produced by a source adapter, before normalization/filtering.
 * This is also the validation boundary for external data (rule 9).
 */
export const sourceJobSchema = z.object({
  source: z.string().min(1),
  sourceJobId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().min(1),
  countryCode: z.string().length(2).nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  remote: z.boolean(),
  employmentTypeRaw: z.string().nullable(),
  seniority: z.string().nullable(),
  experienceRequirement: z.string().nullable(),
  description: z.string().nullable(),
  snippet: z.string().nullable(),
  language: z.string().length(2).nullable(),
  postedAt: isoDateSchema.nullable(),
  raw: z.unknown(),
});

export type SourceJob = z.infer<typeof sourceJobSchema>;

/** Canonical, normalized job — the common representation stored in `jobs`. */
export interface NormalizedJob extends SourceJob {
  titleNormalized: string;
  companyNormalized: string;
  employmentType: JobType | null;
  jobTypeWeight: number;
  entryLevel: boolean;
  dedupeKey: string;
}

export interface HardFilterResult {
  accepted: boolean;
  reasons: string[];
}
