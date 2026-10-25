import {
  ENTRY_EXPERIENCE_VALUES,
  ENTRY_TOKENS,
  EXCLUDE_TOKENS,
  LINKEDIN_ENTRY_SENIORITY,
} from "../../config/seniority.js";
import { JOB_TYPE_PHRASES, JOB_TYPE_WEIGHTS, type JobType } from "../../config/job-types.js";
import type { NormalizedJob, SourceJob } from "./types.js";

/** Lowercase, strip punctuation, collapse whitespace, keep unicode letters/numbers. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove German gender markers (m/w/d) after normalization and collapse again. */
export function normalizeTitle(input: string): string {
  return normalizeText(input)
    .replace(/\b(m w d|f m d|w m d|gn)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(normalizeText(needle)));
}

/** Map a source employment-type string to the canonical allowed set. */
export function normalizeEmploymentType(value: string | null): JobType | null {
  if (!value) return null;
  const v = normalizeText(value);
  if (
    v.includes("working student") ||
    v.includes("werkstudent") ||
    v.includes("studentmedarbetare") ||
    v.includes("studentmedarbejder")
  ) {
    return "Working student";
  }
  if (v.includes("intern") || v.includes("praktik") || v.includes("praktikum") || v.includes("stage")) {
    return "Internship";
  }
  if (
    (v.includes("full") && v.includes("time")) ||
    v.includes("vollzeit") ||
    v.includes("festanstellung")
  ) {
    return "Full-time";
  }
  if ((v.includes("part") && v.includes("time")) || v.includes("teilzeit")) return "Part-time";
  return null;
}

/** Infer the canonical job type from title/description text (order matters). */
export function inferJobType(...texts: Array<string | null | undefined>): JobType | null {
  const hay = normalizeText(texts.filter(Boolean).join(" "));
  const order: JobType[] = ["Working student", "Internship", "Full-time", "Part-time"];
  for (const type of order) {
    if (JOB_TYPE_PHRASES[type].some((phrase) => hay.includes(normalizeText(phrase)))) {
      return type;
    }
  }
  return null;
}

/**
 * Word-boundary internship tokens. `normalizeText` strips punctuation, so a plain `includes`
 * would wrongly match unrelated words ("intern" inside "internal"/"international"); these
 * patterns do not. "stage"/"stagiair" are kept because they are the Dutch/French terms for an
 * internship.
 */
const INTERNSHIP_PATTERNS = [/\bintern(ship)?s?\b/, /\bpraktik/, /\bstag(e|es|iairs?|iaires?)\b/];

/**
 * True when the posting is an internship. Only the title, declared employment type and seniority
 * are inspected, so a description that merely mentions interns does not trip the filter.
 */
export function detectInternship(job: SourceJob): boolean {
  const hay = normalizeText(
    [job.title, job.employmentTypeRaw, job.seniority].filter(Boolean).join(" "),
  );
  return INTERNSHIP_PATTERNS.some((pattern) => pattern.test(hay));
}

/** A posting is entry-level */
export function detectEntryLevel(job: SourceJob): boolean {
  const seniority = (job.seniority ?? "").trim().toLowerCase();
  if (LINKEDIN_ENTRY_SENIORITY.some((s) => s.toLowerCase() === seniority)) return true;

  const hay = normalizeText(
    [job.title, job.snippet ?? "", job.description ?? "", job.experienceRequirement ?? ""].join(" "),
  );
  if (containsAny(hay, ENTRY_TOKENS)) return true;

  if (job.experienceRequirement && containsAny(normalizeText(job.experienceRequirement), ENTRY_EXPERIENCE_VALUES)) {
    return true;
  }
  return false;
}

/** Senior titles are excluded unless the title itself carries an entry token (§3.2). */
export function isExcludedTitle(title: string): boolean {
  const titleN = normalizeTitle(title);
  const hasEntry = containsAny(titleN, ENTRY_TOKENS);
  const hasExclude = containsAny(titleN, EXCLUDE_TOKENS);
  return hasExclude && !hasEntry;
}

export function buildDedupeKey(
  companyNormalized: string,
  titleNormalized: string,
  countryCode: string | null,
  city: string | null,
): string {
  const cityNormalized = city ? normalizeText(city) : "";
  return [companyNormalized, titleNormalized, countryCode ?? "", cityNormalized].join("|");
}

export function normalizeSourceJob(job: SourceJob): NormalizedJob {
  const titleNormalized = normalizeTitle(job.title);
  const companyNormalized = normalizeText(job.company);
  const countryCode = job.countryCode ? job.countryCode.toUpperCase() : null;

  const employmentType =
    normalizeEmploymentType(job.employmentTypeRaw) ??
    inferJobType(job.title, job.snippet, job.description);
  const jobTypeWeight = employmentType ? JOB_TYPE_WEIGHTS[employmentType] : 0;

  const entryLevel = detectEntryLevel(job) && !isExcludedTitle(job.title);

  return {
    ...job,
    countryCode,
    titleNormalized,
    companyNormalized,
    employmentType,
    jobTypeWeight,
    entryLevel,
    dedupeKey: buildDedupeKey(companyNormalized, titleNormalized, countryCode, job.city),
  };
}
