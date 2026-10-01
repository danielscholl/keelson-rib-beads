# ledgerd

A small invoicing service: sessions, an invoice store, a payment gateway
client with retries, attachments on disk, and a recurring-billing job.

Amounts are integer cents. Billing periods are half-open: `[start, end)`.
The version in `package.json` and `src/version.ts` must agree; the health
endpoint reports the latter.
