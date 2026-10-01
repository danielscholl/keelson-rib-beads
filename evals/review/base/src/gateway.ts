export interface Gateway {
  // Idempotent on `key`: charging twice with one key moves money once.
  charge(key: string, amountCents: number, currency: string): Promise<{ chargeId: string }>;
}
