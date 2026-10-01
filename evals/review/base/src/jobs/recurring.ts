import type { Sessions } from "../auth.ts";
import { monthOf } from "../dates.ts";
import { createInvoice, type Deps } from "../handlers.ts";
import { formatCents } from "../money.ts";

export interface Subscription {
  customerId: string;
  // Stored the way the signup form sent it, which is lowercase ("usd").
  currency: string;
  monthlyCents: number;
}

// Opens this month's invoice for every subscription. A customer that already
// has one for the period is skipped by createInvoice's overlap check.
export async function runRecurring(
  deps: Deps,
  sessions: Sessions,
  subscriptions: readonly Subscription[],
): Promise<{ created: number; skipped: number }> {
  const job = sessions.create("job:recurring", "billing");
  const period = monthOf(deps.now());
  let created = 0;
  let skipped = 0;
  try {
    for (const sub of subscriptions) {
      try {
        await createInvoice(deps, job.token, {
          customerId: sub.customerId,
          currency: sub.currency,
          amount: formatCents(sub.monthlyCents, "").trim(),
          periodStart: period.start,
          periodEnd: period.end,
        });
        created++;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("period overlaps")) skipped++;
        else throw err;
      }
    }
  } finally {
    sessions.revoke(job.token);
  }
  return { created, skipped };
}
