import { requireRole, type Session, type Sessions } from "./auth.ts";
import type { TtlCache } from "./cache.ts";
import type { Config } from "./config.ts";
import { overlaps } from "./dates.ts";
import { HttpError, isTransient } from "./errors.ts";
import { saveAttachment } from "./files.ts";
import type { Gateway } from "./gateway.ts";
import { parseAmount } from "./money.ts";
import { type Page, paginate } from "./paginate.ts";
import { withRetry } from "./retry.ts";
import type { Invoice, InvoiceStore } from "./store.ts";
import { VERSION } from "./version.ts";

export interface Deps {
  config: Config;
  sessions: Sessions;
  store: InvoiceStore;
  cache: TtlCache<Summary>;
  gateway: Gateway;
  now: () => number;
}

export interface Summary {
  count: number;
  openCents: number;
  paidCents: number;
}

export interface NewInvoice {
  customerId: string;
  currency: string;
  amount: string;
  periodStart: number;
  periodEnd: number;
}

const LOCAL_ADMIN: Session = {
  token: "",
  userId: "local",
  role: "admin",
  expiresAt: Number.MAX_SAFE_INTEGER,
};

// With auth disabled (local development only) every caller is the local admin.
function authenticate(deps: Deps, token: string | undefined): Session {
  if (!deps.config.requireAuth) return LOCAL_ADMIN;
  return deps.sessions.verify(token);
}

export function health(): { ok: true; version: string } {
  return { ok: true, version: VERSION };
}

export function listInvoices(
  deps: Deps,
  token: string | undefined,
  query: { customerId?: string; cursor?: string; limit?: number },
): Page<Invoice> {
  authenticate(deps, token);
  const limit = Math.min(query.limit ?? 25, deps.config.maxPageSize);
  return paginate(deps.store.list(query.customerId), query.cursor, limit);
}

export async function createInvoice(
  deps: Deps,
  token: string | undefined,
  input: NewInvoice,
): Promise<Invoice> {
  requireRole(authenticate(deps, token), "billing");
  if (input.periodEnd <= input.periodStart) throw new HttpError(400, "empty billing period");
  const amountCents = parseAmount(input.amount);
  const currency = input.currency.toUpperCase();
  return deps.store.transaction((tx) => {
    const period = { start: input.periodStart, end: input.periodEnd };
    const clash = tx
      .list(input.customerId)
      .find(
        (i) => i.status !== "void" && overlaps(period, { start: i.periodStart, end: i.periodEnd }),
      );
    if (clash) throw new HttpError(409, `period overlaps ${clash.id}`);
    const invoice: Invoice = {
      id: tx.nextId(),
      customerId: input.customerId,
      currency,
      amountCents,
      status: "open",
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      createdAt: deps.now(),
    };
    tx.put(invoice);
    deps.cache.invalidate(`summary:${invoice.customerId}`);
    return invoice;
  });
}

export async function payInvoice(
  deps: Deps,
  token: string | undefined,
  id: string,
): Promise<Invoice> {
  requireRole(authenticate(deps, token), "billing");
  return deps.store.transaction(async (tx) => {
    const invoice = tx.get(id);
    if (!invoice) throw new HttpError(404, "no such invoice");
    if (invoice.status !== "open") throw new HttpError(409, `invoice is ${invoice.status}`);
    await withRetry(() => deps.gateway.charge(invoice.id, invoice.amountCents, invoice.currency), {
      ...deps.config.retry,
      isRetryable: isTransient,
    });
    const paid: Invoice = { ...invoice, status: "paid", paidAt: deps.now() };
    tx.put(paid);
    deps.cache.invalidate(`summary:${invoice.customerId}`);
    return paid;
  });
}

export async function voidInvoice(
  deps: Deps,
  token: string | undefined,
  id: string,
): Promise<Invoice> {
  requireRole(authenticate(deps, token), "admin");
  return deps.store.transaction((tx) => {
    const invoice = tx.get(id);
    if (!invoice) throw new HttpError(404, "no such invoice");
    if (invoice.status === "paid") throw new HttpError(409, "a paid invoice cannot be voided");
    const voided: Invoice = { ...invoice, status: "void" };
    tx.put(voided);
    deps.cache.invalidate(`summary:${invoice.customerId}`);
    return voided;
  });
}

export function customerSummary(
  deps: Deps,
  token: string | undefined,
  customerId: string,
): Summary {
  authenticate(deps, token);
  const key = `summary:${customerId}`;
  const cached = deps.cache.get(key);
  if (cached) return cached;
  const invoices = deps.store.list(customerId).filter((i) => i.status !== "void");
  const summary: Summary = {
    count: invoices.length,
    openCents: invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.amountCents, 0),
    paidCents: invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.amountCents, 0),
  };
  deps.cache.set(key, summary);
  return summary;
}

export async function uploadAttachment(
  deps: Deps,
  token: string | undefined,
  invoiceId: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string }> {
  requireRole(authenticate(deps, token), "billing");
  if (!deps.store.get(invoiceId)) throw new HttpError(404, "no such invoice");
  const path = await saveAttachment(deps.config.uploadRoot, invoiceId, name, bytes);
  return { path };
}
