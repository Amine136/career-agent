/**
 * Job type weights. Weight feeds future relevance scoring.
 */
export const JOB_TYPE_WEIGHTS = {
  "Full-time": 5,
  "Working student": 2,
  Internship: 1,
  "Part-time": 1,
} as const;

export type JobType = keyof typeof JOB_TYPE_WEIGHTS;

/** Detection phrases per normalized job type, matched against title + description. */
export const JOB_TYPE_PHRASES: Record<JobType, string[]> = {
  "Full-time": ["full-time", "full time", "vollzeit"],
  "Working student": [
    "werkstudent",
    "working student",
    "studentmedarbejder",
    "studentmedarbetare",
    "part-time student",
  ],
  Internship: ["internship", "intern", "praktikum", "stage", "praktik"],
  "Part-time": ["part-time", "part time", "teilzeit"],
};

export function jobTypeWeight(type: string | null | undefined): number {
  if (!type) return 0;
  return (JOB_TYPE_WEIGHTS as Record<string, number>)[type] ?? 0;
}
