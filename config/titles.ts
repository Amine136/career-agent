/**
 * Canonical English job titles.
 * Localized variants widen recall and are matched back to a canonical title.
 */
export const CANONICAL_TITLES: string[] = [
  "AI Engineer",
  "Junior AI Engineer",
  "Machine Learning Engineer",
  "Generative AI Engineer",
  "LLM Engineer",
  "AI Developer",
  "Applied AI Engineer",
  "GenAI Engineer",
];

/** language code -> localized title variants (§3.1) */
export const LOCALIZED_TITLES: Record<string, string[]> = {
  de: [
    "KI-Ingenieur",
    "KI-Entwickler",
    "Machine-Learning-Engineer",
    "Generative-KI-Ingenieur",
  ],
  nl: ["AI-engineer", "machine learning engineer", "kunstmatige intelligentie"],
  sv: ["AI-ingenjör", "maskininlärning", "generativ AI"],
  ar: ["مهندس ذكاء اصطناعي"],
  ms: ["jurutera AI", "pembelajaran mesin"],
  fr: ["ingénieur IA", "apprentissage automatique"],
};

/** Search queries for one country: canonical titles + variants for its languages. */
export function queriesForLanguages(languages: string[]): string[] {
  const variants = languages.flatMap((lang) => LOCALIZED_TITLES[lang] ?? []);
  return [...CANONICAL_TITLES, ...variants];
}

/**
 * Remote-intent queries for one country: the same canonical/localized titles prefixed with
 * "Remote". Source filters (LinkedIn `f_WT=2`, Indeed's remote attribute) are unreliable, but a
 * posting whose text says "remote" is picked up by both the ingestion heuristic and the AI
 * scorer, so these surface remote roles directly for the remote-first passes.
 */
export function remoteQueriesForLanguages(languages: string[]): string[] {
  const variants = languages.flatMap((lang) => LOCALIZED_TITLES[lang] ?? []);
  return [...CANONICAL_TITLES, ...variants].map((title) => `Remote ${title}`);
}

/**
 * Priority-ordered Indeed search categories. Indeed is paid per request, so we only spend the
 * limited search budget on the highest-value AI/ML queries.
 */
export const INDEED_CATEGORY_QUERIES: string[] = [
  "Machine Learning",
  "AI",
  "NLP Engineer",
  "Data Science",
];
