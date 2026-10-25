import { z } from "zod";

/** Canonical verdict stored in `jobs.ai_decision`. */
export type AiDecision = "KEEP" | "DISCARD";

/** Canonical work arrangement stored in `jobs.ai_workplace`. */
export type AiWorkplace = "remote" | "hybrid" | "onsite" | "unknown";

/** Normalize the model's `workplace` answer to the stored enum (unknown on anything else). */
export function normalizeWorkplace(value: string | null | undefined): AiWorkplace {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "remote" || v === "hybrid" || v === "onsite" || v === "unknown") return v;
  if (v.startsWith("remote")) return "remote";
  if (v.startsWith("hybrid")) return "hybrid";
  if (v.startsWith("on") || v.startsWith("office") || v.startsWith("site")) return "onsite";
  return "unknown";
}

/** Canonical visa-sponsorship verdict stored in `jobs.ai_visa`. */
export type AiVisa = "sponsors" | "unknown" | "no_sponsorship";

/** Normalize the model's `visa` answer to the stored enum (unknown on anything else). */
export function normalizeVisa(value: string | null | undefined): AiVisa {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "sponsors" || v === "unknown" || v === "no_sponsorship") return v;
  if (v.startsWith("sponsor") || v === "yes" || v.startsWith("visa sponsor")) return "sponsors";
  if (
    v.startsWith("no ") ||
    v.startsWith("not ") ||
    v.startsWith("without") ||
    v === "no" ||
    v === "none" ||
    v.includes("no visa") ||
    v.includes("no sponsorship") ||
    /(cannot|can not|unable to|will not|won't|do not|does not)\s+(visa\s+)?sponsor/.test(v)
  ) {
    return "no_sponsorship";
  }
  return "unknown";
}

/**
 * The model is instructed to return KEEP or REJECT; we also tolerate DISCARD and normalize
 * everything non-KEEP to DISCARD so the database check constraint stays simple.
 */
export function normalizeDecision(value: string): AiDecision {
  return value.trim().toUpperCase() === "KEEP" ? "KEEP" : "DISCARD";
}

const percent = z.coerce
  .number()
  .transform((value) => Math.round(value))
  .pipe(z.number().int().min(0).max(100));

/**
 * The exact JSON contract requested from the model (see `prompt.ts`). Validation is the
 * boundary for model output: malformed responses are rejected and the job stays pending.
 */
export const aiScoreSchema = z.object({
  score: percent,
  decision: z
    .string()
    .transform(normalizeDecision)
    .pipe(z.enum(["KEEP", "DISCARD"])),
  confidence: percent,
  workplace: z
    .string()
    .nullish()
    .transform((value) => normalizeWorkplace(value)),
  visa: z
    .string()
    .nullish()
    .transform((value) => normalizeVisa(value)),
  missing_critical_requirements: z.array(z.string()).default([]),
  reason: z.string().default(""),
});

export type AiScore = z.infer<typeof aiScoreSchema>;

/** The subset of a job the scorer needs to build the prompt. */
export interface ScoreableJob {
  id: string;
  title: string;
  companyName: string;
  countryCode: string | null;
  city: string | null;
  location: string | null;
  employmentType: string | null;
  seniority: string | null;
  experienceRequirement: string | null;
  description: string | null;
  snippet: string | null;
}
