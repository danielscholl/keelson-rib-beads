const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

// "12.3" -> 1230. Works on the digits, never through a float.
export function parseAmount(text: string): number {
  const match = AMOUNT.exec(text.trim());
  if (!match) throw new Error(`invalid amount: ${text}`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;
}

export function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction} ${currency}`;
}

// Splits `total` by integer weights. The parts always sum to `total`: leftover
// cents go one each to the earliest parts.
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("weights must sum to a positive number");
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let leftover = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; leftover > 0; i = (i + 1) % parts.length, leftover--) {
    parts[i] = (parts[i] ?? 0) + 1;
  }
  return parts;
}
