export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid cursor: ${cursor}`);
  return offset;
}

// Offset cursors: `nextCursor` is the index of the first item of the next page.
export function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): Page<T> {
  const start = parseCursor(cursor);
  const end = start + limit;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  };
}
