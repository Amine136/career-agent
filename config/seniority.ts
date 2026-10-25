/**
 * Seniority rules. Entry-level only.
 */

/** LinkedIn `seniority` values treated as entry-level. */
export const LINKEDIN_ENTRY_SENIORITY = ["Entry level", "Internship"];

/** LinkedIn `seniority` values that are borderline and should be flagged. */
export const LINKEDIN_BORDERLINE_SENIORITY = ["Associate"];

/** Tokens (case-insensitive) that mark a posting as entry-level. */
export const ENTRY_TOKENS: string[] = [
  "junior",
  "entry level",
  "entry-level",
  "first experience",
  "graduate",
  "trainee",
  "associate",
  "intern",
  "0-2 years",
  "0–2 years",
  "no experience",
  "recent graduate",
  "berufseinsteiger",
  "erste berufserfahrung",
  "berufserfahrung: erste",
  "absolvent",
  "praktikum",
  "werkstudent",
];

/** Tokens (case-insensitive) that mark a posting as non-entry unless an ENTRY_TOKEN is also present. */
export const EXCLUDE_TOKENS: string[] = [
  "senior",
  "lead",
  "principal",
  "staff",
  "head",
  "director",
  "manager",
  "architect",
  "chief",
  "vp",
  "expert",
];

/** Values of the `experience` field treated as entry-level. */
export const ENTRY_EXPERIENCE_VALUES = ["0", "0-2", "first", "entry"];
