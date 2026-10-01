export type InvoiceStatus = "open" | "paid" | "void";

export interface Invoice {
  id: string;
  customerId: string;
  currency: string;
  amountCents: number;
  status: InvoiceStatus;
  periodStart: number;
  periodEnd: number;
  createdAt: number;
  paidAt?: number;
}

export interface Tx {
  get(id: string): Invoice | undefined;
  put(invoice: Invoice): void;
  list(customerId?: string): Invoice[];
  nextId(): string;
}

export class InvoiceStore {
  private readonly invoices = new Map<string, Invoice>();
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;

  private readonly tx: Tx = {
    get: (id) => this.invoices.get(id),
    put: (invoice) => {
      this.invoices.set(invoice.id, invoice);
    },
    list: (customerId) => this.list(customerId),
    nextId: () => `inv_${String(++this.seq).padStart(6, "0")}`,
  };

  // Exclusive access for the duration of `fn`. A caller that reads an invoice
  // and then writes it must do both inside one transaction.
  async transaction<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    const prior = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn(this.tx);
    } finally {
      release();
    }
  }

  // Snapshot reads; fine for display, never as the basis for a write.
  get(id: string): Invoice | undefined {
    return this.invoices.get(id);
  }

  list(customerId?: string): Invoice[] {
    const all = [...this.invoices.values()].sort((a, b) => a.id.localeCompare(b.id));
    return customerId === undefined ? all : all.filter((i) => i.customerId === customerId);
  }
}
