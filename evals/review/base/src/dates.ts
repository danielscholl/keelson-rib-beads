export interface Period {
  start: number;
  end: number;
}

// The UTC calendar month containing `at`, as a half-open [start, end) range.
export function monthOf(at: number): Period {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

// Half-open ranges overlap only when each starts before the other ends, so
// two consecutive months do not overlap.
export function overlaps(a: Period, b: Period): boolean {
  return a.start < b.end && b.start < a.end;
}
