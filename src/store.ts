// Deliberately in-memory: this is a reference integration, not a product.
// In a real build this is a table, and the important column is the CACHED
// onboarding state kept fresh by the account.updated webhook.

export type SellerState = {
  accountId: string
  displayName: string
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  currentlyDue: string[]
  disabledReason: string | null
  updatedAt: string
}

const sellers = new Map<string, SellerState>()

export const store = {
  upsert(s: SellerState) { sellers.set(s.accountId, s) },
  get(id: string) { return sellers.get(id) },
  all() { return [...sellers.values()] },
}

// The single most important function in this file.
//
// There is NO single Stripe field that means "onboarding is done". Stripe's own
// docs are explicit about it, and the mistake is extremely common: teams treat
// the return_url redirect as success. The redirect only means the flow was
// entered and exited properly — the account can come back with nothing collected.
//
// A seller can take money only when all three hold.
export function canAcceptPayments(s: SellerState): boolean {
  return s.chargesEnabled && s.detailsSubmitted && s.currentlyDue.length === 0
}
