// Seeded review cases over the `base/` fixture. Each case is a branch a
// reviewer sees as a diff: `edits` rewrite base files, `writes` add new ones.
// A `bug` case carries exactly one merge-blocking defect and says where a
// finding must point (`accept`); a `clean` case carries none.

export interface Edit {
  file: string;
  find: string;
  replace: string;
}

export interface Accept {
  file: string;
  // A substring of the first accepted line, and optionally of the last one.
  needle: string;
  until?: string;
}

export interface ReviewCase {
  id: string;
  split: "train" | "test";
  kind: "bug" | "clean";
  subject: string;
  edits?: Edit[];
  writes?: Record<string, string>;
  accept?: Accept[];
}

const HANDLERS = "src/handlers.ts";

const PAY_LOOKUP = `    const invoice = tx.get(id);
    if (!invoice) throw new HttpError(404, "no such invoice");
    if (invoice.status !== "open") throw new HttpError(409, \`invoice is \${invoice.status}\`);`;

const VOID_LOOKUP = `    const invoice = tx.get(id);
    if (!invoice) throw new HttpError(404, "no such invoice");
    if (invoice.status === "paid") throw new HttpError(409, "a paid invoice cannot be voided");`;

const FIND_INVOICE: Edit[] = [
  {
    file: HANDLERS,
    find: 'import type { Invoice, InvoiceStore } from "./store.ts";',
    replace: 'import type { Invoice, InvoiceStore, Tx } from "./store.ts";',
  },
  {
    file: HANDLERS,
    find: "export async function payInvoice(",
    replace: `function findInvoice(tx: Tx, id: string): Invoice {
  const invoice = tx.get(id);
  if (!invoice) throw new HttpError(404, "no such invoice");
  return invoice;
}

export async function payInvoice(`,
  },
  {
    file: HANDLERS,
    find: PAY_LOOKUP,
    replace: `    const invoice = findInvoice(tx, id);
    if (invoice.status !== "open") throw new HttpError(409, \`invoice is \${invoice.status}\`);`,
  },
];

const PAGE_TOTAL: Edit[] = [
  {
    file: "src/paginate.ts",
    find: "  nextCursor: string | null;\n}",
    replace: "  nextCursor: string | null;\n  total: number;\n}",
  },
];

const RETRY_OPTIONS: Edit[] = [
  {
    file: "src/retry.ts",
    find: "  sleep?: (ms: number) => Promise<void>;\n}",
    replace:
      "  sleep?: (ms: number) => Promise<void>;\n  onRetry?: (err: unknown, attempt: number) => void;\n}",
  },
  {
    file: "src/retry.ts",
    find: "// Calls `fn` once",
    replace: `// Half fixed, half random, so a burst of failures does not retry in step.
const jitter = (ms: number) => ms / 2 + Math.random() * (ms / 2);

// Calls \`fn\` once`,
  },
];

export const CASES: ReviewCase[] = [
  {
    id: "void-guard-dropped",
    split: "train",
    kind: "bug",
    subject: "refactor: share the invoice lookup between pay and void",
    edits: [
      ...FIND_INVOICE,
      { file: HANDLERS, find: VOID_LOOKUP, replace: "    const invoice = findInvoice(tx, id);" },
    ],
    accept: [
      { file: HANDLERS, needle: "export async function voidInvoice(", until: "return voided;" },
      { file: HANDLERS, needle: "function findInvoice(", until: "return invoice;" },
    ],
  },
  {
    id: "lookup-extract-clean",
    split: "train",
    kind: "clean",
    subject: "refactor: share the invoice lookup between pay and void",
    edits: [
      ...FIND_INVOICE,
      {
        file: HANDLERS,
        find: VOID_LOOKUP,
        replace: `    const invoice = findInvoice(tx, id);
    if (invoice.status === "paid") throw new HttpError(409, "a paid invoice cannot be voided");`,
      },
    ],
  },
  {
    id: "sliding-session-never-expires",
    split: "test",
    kind: "bug",
    subject: "feat: slide the session expiry forward on each verified request",
    edits: [
      {
        file: "src/auth.ts",
        find: `    if (session.expiresAt <= this.now()) {
      this.byToken.delete(token);
      throw new HttpError(401, "session expired");
    }
    return session;`,
        replace: `    const now = this.now();
    session.expiresAt = now + this.ttlMs;
    if (session.expiresAt <= now) {
      this.byToken.delete(token);
      throw new HttpError(401, "session expired");
    }
    return session;`,
      },
    ],
    accept: [{ file: "src/auth.ts", needle: "const now = this.now();", until: "return session;" }],
  },
  {
    id: "last-page-dropped",
    split: "train",
    kind: "bug",
    subject: "feat: return the total count with each page",
    edits: [
      ...PAGE_TOTAL,
      {
        file: "src/paginate.ts",
        find: `  const end = start + limit;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  };`,
        replace: `  const end = Math.min(start + limit, items.length);
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length - 1 ? String(end) : null,
    total: items.length,
  };`,
      },
    ],
    accept: [{ file: "src/paginate.ts", needle: "end < items.length - 1" }],
  },
  {
    id: "page-total-clean",
    split: "test",
    kind: "clean",
    subject: "feat: return the total count with each page",
    edits: [
      ...PAGE_TOTAL,
      {
        file: "src/paginate.ts",
        find: `  const end = start + limit;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  };`,
        replace: `  const end = Math.min(start + limit, items.length);
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
    total: items.length,
  };`,
      },
    ],
  },
  {
    id: "retry-ignores-retryable",
    split: "test",
    kind: "bug",
    subject: "feat: add jitter and an onRetry hook to withRetry",
    edits: [
      ...RETRY_OPTIONS,
      {
        file: "src/retry.ts",
        find: `      if (!opts.isRetryable(err) || attempt >= opts.max) throw err;
      await sleep(opts.baseMs * 2 ** attempt);`,
        replace: `      if (attempt >= opts.max) throw err;
      opts.onRetry?.(err, attempt + 1);
      await sleep(jitter(opts.baseMs * 2 ** attempt));`,
      },
    ],
    accept: [{ file: "src/retry.ts", needle: "if (attempt >= opts.max) throw err;" }],
  },
  {
    id: "retry-jitter-clean",
    split: "test",
    kind: "clean",
    subject: "feat: add jitter and an onRetry hook to withRetry",
    edits: [
      ...RETRY_OPTIONS,
      {
        file: "src/retry.ts",
        find: "      await sleep(opts.baseMs * 2 ** attempt);",
        replace: `      opts.onRetry?.(err, attempt + 1);
      await sleep(jitter(opts.baseMs * 2 ** attempt));`,
      },
    ],
  },
  {
    id: "amount-through-float",
    split: "train",
    kind: "bug",
    subject: "feat: accept thousands separators in amounts",
    edits: [
      {
        file: "src/money.ts",
        find: `  const match = AMOUNT.exec(text.trim());
  if (!match) throw new Error(\`invalid amount: \${text}\`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;`,
        replace: `  const cleaned = text.trim().replace(/,/g, "");
  if (!AMOUNT.test(cleaned)) throw new Error(\`invalid amount: \${text}\`);
  return Math.floor(Number(cleaned) * 100);`,
      },
    ],
    accept: [{ file: "src/money.ts", needle: "Math.floor(Number(cleaned) * 100)" }],
  },
  {
    id: "allocate-loses-cents",
    split: "test",
    kind: "bug",
    subject: "refactor: simplify allocate",
    edits: [
      {
        file: "src/money.ts",
        find: `  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let leftover = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; leftover > 0; i = (i + 1) % parts.length, leftover--) {
    parts[i] = (parts[i] ?? 0) + 1;
  }
  return parts;`,
        replace: "  return weights.map((w) => Math.round((total * w) / sum));",
      },
    ],
    accept: [{ file: "src/money.ts", needle: "Math.round((total * w) / sum)" }],
  },
  {
    id: "cache-ttl-units",
    split: "train",
    kind: "bug",
    subject: "feat: configure the summary cache TTL in seconds",
    edits: [
      {
        file: "src/config.ts",
        find: "  cacheTtlMs: number;",
        replace: "  cacheTtlSeconds: number;",
      },
      {
        file: "src/config.ts",
        find: "    cacheTtlMs: int(env.CACHE_TTL_MS, 5000),",
        replace: "    cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, 5),",
      },
      {
        file: "src/app.ts",
        find: "new TtlCache<Summary>(config.cacheTtlMs)",
        replace: "new TtlCache<Summary>(config.cacheTtlSeconds)",
      },
    ],
    accept: [
      { file: "src/app.ts", needle: "new TtlCache<Summary>(config.cacheTtlSeconds)" },
      { file: "src/config.ts", needle: "cacheTtlSeconds: int(" },
    ],
  },
  {
    id: "attachment-folder-escape",
    split: "test",
    kind: "bug",
    subject: "feat: allow attachments in a subfolder of the invoice",
    edits: [
      {
        file: "src/files.ts",
        find: "export function resolveUploadPath(root: string, invoiceId: string, name: string): string {",
        replace: `export function resolveUploadPath(
  root: string,
  invoiceId: string,
  name: string,
  folder = "",
): string {`,
      },
      {
        file: "src/files.ts",
        find: "  const target = resolve(base, invoiceId, name);",
        replace: "  const target = resolve(base, invoiceId, folder, name);",
      },
      {
        file: "src/files.ts",
        find: `  bytes: Uint8Array,
): Promise<string> {
  const target = resolveUploadPath(root, invoiceId, name);`,
        replace: `  bytes: Uint8Array,
  folder = "",
): Promise<string> {
  const target = resolveUploadPath(root, invoiceId, name, folder);`,
      },
      {
        file: HANDLERS,
        find: `  bytes: Uint8Array,
): Promise<{ path: string }> {`,
        replace: `  bytes: Uint8Array,
  folder?: string,
): Promise<{ path: string }> {`,
      },
      {
        file: HANDLERS,
        find: "saveAttachment(deps.config.uploadRoot, invoiceId, name, bytes);",
        replace: "saveAttachment(deps.config.uploadRoot, invoiceId, name, bytes, folder);",
      },
    ],
    accept: [
      {
        file: "src/files.ts",
        needle: "export function resolveUploadPath(",
        until: "return target;",
      },
      {
        file: HANDLERS,
        needle: "export async function uploadAttachment(",
        until: "return { path };",
      },
    ],
  },
  {
    id: "currency-check-breaks-recurring",
    split: "train",
    kind: "bug",
    subject: "feat: reject unsupported currencies on invoice creation",
    edits: [
      {
        file: HANDLERS,
        find: "export function health()",
        replace: `const CURRENCIES = new Set(["USD", "EUR", "GBP"]);

export function health()`,
      },
      {
        file: HANDLERS,
        find: "  const currency = input.currency.toUpperCase();",
        replace: `  if (!CURRENCIES.has(input.currency)) {
    throw new HttpError(400, \`unsupported currency: \${input.currency}\`);
  }
  const currency = input.currency;`,
      },
    ],
    accept: [
      {
        file: HANDLERS,
        needle: "if (!CURRENCIES.has(input.currency)) {",
        until: "const currency = input.currency;",
      },
      { file: "src/jobs/recurring.ts", needle: "currency: sub.currency," },
    ],
  },
  {
    id: "version-drift",
    split: "test",
    kind: "bug",
    subject: "chore: release 1.5.0",
    edits: [{ file: "package.json", find: '"version": "1.4.0"', replace: '"version": "1.5.0"' }],
    writes: {
      "CHANGELOG.md": `# Changelog

## 1.5.0

- Invoices report their billing period in list responses.
- The recurring job skips customers that already hold an invoice for the month.

## 1.4.0

- Attachments on invoices.
`,
    },
    accept: [
      { file: "package.json", needle: '"version": "1.5.0"' },
      { file: "src/version.ts", needle: "export const VERSION" },
      { file: "CHANGELOG.md", needle: "## 1.5.0" },
    ],
  },
  {
    id: "pay-outside-transaction",
    split: "train",
    kind: "bug",
    subject: "perf: do not hold the store lock across the gateway call",
    edits: [
      {
        file: HANDLERS,
        find: `  return deps.store.transaction(async (tx) => {
${PAY_LOOKUP}
    await withRetry(() => deps.gateway.charge(invoice.id, invoice.amountCents, invoice.currency), {
      ...deps.config.retry,
      isRetryable: isTransient,
    });
    const paid: Invoice = { ...invoice, status: "paid", paidAt: deps.now() };`,
        replace: `  const invoice = deps.store.get(id);
  if (!invoice) throw new HttpError(404, "no such invoice");
  if (invoice.status !== "open") throw new HttpError(409, \`invoice is \${invoice.status}\`);
  await withRetry(() => deps.gateway.charge(invoice.id, invoice.amountCents, invoice.currency), {
    ...deps.config.retry,
    isRetryable: isTransient,
  });
  return deps.store.transaction((tx) => {
    const paid: Invoice = { ...invoice, status: "paid", paidAt: deps.now() };`,
      },
    ],
    accept: [
      { file: HANDLERS, needle: "const invoice = deps.store.get(id);", until: "return paid;" },
    ],
  },
  {
    id: "summary-empty-customer",
    split: "test",
    kind: "bug",
    subject: "feat: report the average and the largest invoice in the summary",
    edits: [
      {
        file: HANDLERS,
        find: "  paidCents: number;\n}",
        replace: "  paidCents: number;\n  averageCents: number;\n  largestId: string;\n}",
      },
      {
        file: HANDLERS,
        find: `  const summary: Summary = {
    count: invoices.length,`,
        replace: `  const totalCents = invoices.reduce((s, i) => s + i.amountCents, 0);
  const summary: Summary = {
    count: invoices.length,
    averageCents: Math.round(totalCents / invoices.length),
    largestId: invoices.reduce((a, b) => (b.amountCents > a.amountCents ? b : a)).id,`,
      },
    ],
    accept: [{ file: HANDLERS, needle: "const totalCents = invoices.reduce", until: "largestId:" }],
  },
  {
    id: "auth-default-flipped",
    split: "train",
    kind: "bug",
    subject: "refactor: parse boolean settings with one helper",
    edits: [
      {
        file: "src/config.ts",
        find: "export function loadConfig(",
        replace: `function bool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function loadConfig(`,
      },
      {
        file: "src/config.ts",
        find: '    requireAuth: env.REQUIRE_AUTH !== "false",',
        replace: "    requireAuth: bool(env.REQUIRE_AUTH),",
      },
    ],
    accept: [{ file: "src/config.ts", needle: "function bool(", until: "requireAuth: bool(" }],
  },
  {
    id: "adjacent-periods-overlap",
    split: "test",
    kind: "bug",
    subject: "feat: add a contains helper for billing periods",
    edits: [
      {
        file: "src/dates.ts",
        find: `export function overlaps(a: Period, b: Period): boolean {
  return a.start < b.end && b.start < a.end;
}`,
        replace: `export function overlaps(a: Period, b: Period): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function contains(period: Period, at: number): boolean {
  return period.start <= at && at < period.end;
}`,
      },
    ],
    accept: [{ file: "src/dates.ts", needle: "a.start <= b.end && b.start <= a.end" }],
  },
  {
    id: "upload-failure-swallowed",
    split: "train",
    kind: "bug",
    subject: "fix: do not fail the request when an attachment cannot be written",
    edits: [
      {
        file: HANDLERS,
        find: `  const path = await saveAttachment(deps.config.uploadRoot, invoiceId, name, bytes);
  return { path };`,
        replace: `  try {
    const path = await saveAttachment(deps.config.uploadRoot, invoiceId, name, bytes);
    return { path };
  } catch (err) {
    console.warn(\`attachment \${name} for \${invoiceId} was not saved\`, err);
    return { path: "" };
  }`,
      },
    ],
    accept: [{ file: HANDLERS, needle: "  try {", until: 'return { path: "" };' }],
  },
  {
    id: "cache-prefix-clean",
    split: "train",
    kind: "clean",
    subject: "feat: invalidate cache entries by key prefix",
    edits: [
      {
        file: "src/cache.ts",
        find: `  invalidate(key: string): void {
    this.entries.delete(key);
  }`,
        replace: `  invalidate(key: string): void {
    this.entries.delete(key);
  }

  invalidatePrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && this.entries.delete(key)) removed++;
    }
    return removed;
  }`,
      },
    ],
  },
  {
    id: "get-invoice-clean",
    split: "test",
    kind: "clean",
    subject: "feat: add a handler that returns one invoice",
    edits: [
      {
        file: HANDLERS,
        find: "export async function createInvoice(",
        replace: `export function getInvoice(deps: Deps, token: string | undefined, id: string): Invoice {
  authenticate(deps, token);
  const invoice = deps.store.get(id);
  if (!invoice) throw new HttpError(404, "no such invoice");
  return invoice;
}

export async function createInvoice(`,
      },
    ],
  },
];
