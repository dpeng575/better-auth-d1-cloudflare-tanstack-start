/**
 * Static plan catalog. Kept in code (not DB) until pricing operations need
 * runtime control — plans are cheap to ship, and credits actually live in
 * the ledger. Subscriptions (P6) will reuse this catalog shape.
 */
export interface Plan {
  code: string;
  name: string;
  kind: "credits_pack";
  amountCents: number;
  currency: string;
  credits: number;
  description: string;
}

export const PLANS: Plan[] = [
  {
    code: "credits_pack_100",
    name: "Starter Pack",
    kind: "credits_pack",
    amountCents: 499,
    currency: "usd",
    credits: 100,
    description: "100 credits — about 10 mock-fast generations",
  },
  {
    code: "credits_pack_500",
    name: "Creator Pack",
    kind: "credits_pack",
    amountCents: 1999,
    currency: "usd",
    credits: 500,
    description: "500 credits — best value for heavy creators",
  },
];

export function getPlan(code: string): Plan | undefined {
  return PLANS.find((p) => p.code === code);
}
