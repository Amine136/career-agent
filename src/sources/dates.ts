function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shiftDays(now: Date, days: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** Parse relative strings such as "3 days ago", "Just posted", "Yesterday". */
export function parseRelativeDate(text: string, now: Date = new Date()): string | null {
  const t = text.toLowerCase();
  if (!t) return null;
  if (t.includes("just posted") || t.includes("today") || t.includes("just now")) {
    return shiftDays(now, 0);
  }
  if (t.includes("yesterday")) return shiftDays(now, -1);
  const days = t.match(/(\d+)\s*day/);
  if (days) return shiftDays(now, -Number(days[1]));
  const hours = t.match(/(\d+)\s*hour/);
  if (hours) return shiftDays(now, 0);
  const minutes = t.match(/(\d+)\s*min/);
  if (minutes) return shiftDays(now, 0);
  return null;
}

/** Coerce any source-provided date value to YYYY-MM-DD, or null. */
export function toIsoDate(
  value: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return toIso(new Date(parsed));
  return parseRelativeDate(trimmed, now);
}
