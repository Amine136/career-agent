/**
 * Deterministic workplace (remote) detection over source text.
 *
 * This is the ingestion-time fallback stored in `jobs.remote`. The AI scorer later produces an
 * authoritative `ai_workplace` verdict; the `is_remote` column prefers it when present and falls
 * back to this heuristic for jobs the scorer has not reached yet.
 */

/** Lowercase and collapse whitespace so keyword matching is predictable. */
function norm(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Unambiguous phrases that are safe to trust even when they only appear in the description. */
const STRONG_REMOTE_PHRASES = [
  "fully remote",
  "100% remote",
  "100 % remote",
  "remote-first",
  "remote first",
  "work from home",
  "work from anywhere",
  "home office",
  "homeoffice",
  "home-office",
  "telearbeit",
  "mobiles arbeiten",
  "mobile arbeit",
  "remote möglich",
  "remote position",
  "remote role",
];

/** Loose remote keywords; only trusted from location/title, not the description body. */
const REMOTE_KEYWORDS = [...STRONG_REMOTE_PHRASES, "remote", "wfh", "telework", "telecommut"];

/** Phrases that explicitly rule remote work out and veto a match. */
const NEGATIONS = [
  "no remote",
  "not remote",
  "not a remote",
  "remote is not",
  "remote not possible",
  "remote work not",
  "remote work is not",
  "no home office",
  "no homeoffice",
  "kein home office",
  "kein homeoffice",
  "kein home-office",
  "keine remote",
  "kein remote",
  "nicht remote",
  "onsite only",
  "on-site only",
  "on site only",
];

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export interface RemoteSignals {
  location?: string | null;
  title?: string | null;
  description?: string | null;
}

/**
 * Detect whether a posting is remote. Location/title are trusted for any remote keyword; the
 * description only counts for strong, unambiguous phrases. A negation vetoes the match.
 */
export function detectRemote({ location, title, description }: RemoteSignals): boolean {
  const head = norm([location, title].filter(Boolean).join(" "));
  const body = norm(description ?? "");

  // A negation anywhere vetoes the match (e.g. "onsite only" in the title, "not a remote role"
  // in the description).
  if (hasAny(`${head} ${body}`, NEGATIONS)) {
    return false;
  }
  if (head.length > 0 && hasAny(head, REMOTE_KEYWORDS)) {
    return true;
  }
  if (body.length > 0 && hasAny(body, STRONG_REMOTE_PHRASES)) {
    return true;
  }
  return false;
}
