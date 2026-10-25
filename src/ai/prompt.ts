import { CANDIDATE_PROFILE } from "../../config/candidate-profile.js";
import type { ScoreableJob } from "./types.js";

/**
 * Version of the candidate profile + instructions. Bump when either changes so a future
 * rescoring pass can target rows whose `ai_prompt_version` is stale.
 */
export const PROMPT_VERSION = "2026-10-25.1";

/** Hard cap on how much job text is sent to the model (characters). */
export const JOB_DESCRIPTION_MAX_CHARS = 10_000;

/**
 * Prompt template. `{{CANDIDATE_PROFILE}}` comes from `config/candidate-profile.ts` and
 * `{{JOB_DESCRIPTION}}` is replaced with the capped job block.
 */
export const PROMPT_TEMPLATE = `You are a conservative AI job-matching evaluator.

Your task is to determine whether a job is worth keeping for the candidate.

IMPORTANT RULE:
Only REJECT a job when there is strong evidence that the candidate cannot satisfy
a mandatory requirement.

If something is preferred, nice-to-have, flexible, unclear, or potentially
achievable, KEEP the job.

Do NOT reject someone simply because they lack some preferred skills or have
less experience than a preferred number.

CANDIDATE PROFILE:

{{CANDIDATE_PROFILE}}

JOB DESCRIPTION:

{{JOB_DESCRIPTION}}

Evaluate the job against the candidate.

Return ONLY valid JSON:

{
  "score": 0,
  "decision": "KEEP",
  "confidence": 0,
  "workplace": "remote",
  "visa": "unknown",
  "missing_critical_requirements": [],
  "reason": ""
}

SCORING GUIDELINES:
- 90-100: Excellent match
- 75-89: Strong match
- 60-74: Reasonable/possible match
- 40-59: Weak but potentially worth considering
- 0-39: Poor match

WORKPLACE:
- "workplace" classifies how the role is performed, based only on the posting:
  * "remote": fully or predominantly remote - the posting offers remote work, work from home /
    homeoffice, or says the position or team is remote, with no regular mandatory on-site days.
    Occasional or optional office visits still count as "remote".
  * "hybrid": a fixed split with regular mandatory on-site days (e.g. "2 days per week in the
    office", "hybrid: 3 days on-site").
  * "onsite": on-site only; remote explicitly ruled out.
  * "unknown": the posting does not state the work arrangement.
- The title, location and description are all evidence. If any of them says remote, work from
  home, homeoffice or "remote friendly", prefer "remote" unless the posting explicitly requires
  regular on-site attendance (then use "hybrid" or "onsite").
- Do not infer "remote" from the candidate's preferences; judge the posting itself.

VISA SPONSORSHIP:
- "visa" classifies whether the posting offers work-visa sponsorship, based only on the posting:
  * "sponsors": the posting clearly says it offers visa sponsorship / supports work-permit
    applications / will sponsor a visa (e.g. "we sponsor visas", "visa sponsorship available",
    "relocation and visa support").
  * "no_sponsorship": the posting clearly refuses it (e.g. "no visa sponsorship", "must have the
    right to work", "we cannot sponsor", "only candidates with a valid work permit").
  * "unknown": the posting does not state anything about sponsorship. This is the default.
- Sponsorship is usually not mentioned: use "unknown" unless the posting is explicit. Do not infer
  either answer from the candidate's situation, the country, or the role's seniority.
- A line that only says the employer supports relocation is not, by itself, visa sponsorship.

DECISION:
- REJECT only for clear, important incompatibilities.
- KEEP if the candidate could reasonably apply.
- Mandatory requirements matter much more than preferred requirements.
- "Preferred", "ideally", "nice to have", and "plus" are NOT mandatory.
- If the job asks for more experience but does not explicitly make it mandatory,
  do not reject solely because of experience.
- If a mandatory language, degree, certification, authorization, location,
  or other requirement is clearly impossible for the candidate, REJECT.
- Do not assume missing information means the candidate fails the requirement.`;

/** Keep only the first `max` characters of `text`. */
export function truncate(text: string, max = JOB_DESCRIPTION_MAX_CHARS): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Render the candidate-visible context for a job. Metadata comes first so it survives
 * truncation; the description/snippet is then capped at `JOB_DESCRIPTION_MAX_CHARS`.
 */
export function buildJobBlock(job: ScoreableJob): string {
  const lines: (string | null)[] = [
    `Title: ${job.title}`,
    `Company: ${job.companyName}`,
    job.countryCode ? `Country: ${job.countryCode}` : null,
    job.city ? `City: ${job.city}` : null,
    job.location ? `Location: ${job.location}` : null,
    job.employmentType ? `Employment type: ${job.employmentType}` : null,
    job.seniority ? `Seniority: ${job.seniority}` : null,
    job.experienceRequirement ? `Experience requirement: ${job.experienceRequirement}` : null,
    "",
    job.description?.trim() || job.snippet?.trim() || "(no description provided)",
  ];
  return truncate(lines.filter((line): line is string => line !== null).join("\n"));
}

/** Build the full prompt for one job. */
export function buildPrompt(job: ScoreableJob): string {
  return PROMPT_TEMPLATE.replace("{{CANDIDATE_PROFILE}}", CANDIDATE_PROFILE).replace(
    "{{JOB_DESCRIPTION}}",
    buildJobBlock(job),
  );
}
