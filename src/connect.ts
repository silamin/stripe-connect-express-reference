import Stripe from 'stripe'
import { config, applicationFeeAmount } from './config.js'
import { store, type SellerState } from './store.js'

export const stripe = new Stripe(config.stripeSecretKey, {
  // Pin the version. An unpinned integration changes behaviour on Stripe's
  // schedule rather than yours.
  apiVersion: '2024-06-20',
  appInfo: { name: 'silamin-connect-reference', version: '1.0.0' },
})

/** Map a Stripe Account onto our own cached state. One place, so it can't drift. */
export function toSellerState(acct: Stripe.Account, displayName?: string): SellerState {
  return {
    accountId: acct.id,
    displayName: displayName ?? store.get(acct.id)?.displayName ?? acct.id,
    chargesEnabled: acct.charges_enabled ?? false,
    payoutsEnabled: acct.payouts_enabled ?? false,
    detailsSubmitted: acct.details_submitted ?? false,
    currentlyDue: acct.requirements?.currently_due ?? [],
    disabledReason: acct.requirements?.disabled_reason ?? null,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Create an Express connected account.
 *
 * `capabilities` must be REQUESTED explicitly. Omitting them is a classic silent
 * failure: onboarding completes, the account looks fine, and charges_enabled
 * never flips because nothing ever asked for card_payments/transfers.
 */
export async function createExpressSeller(displayName: string, country: string) {
  const acct = await stripe.accounts.create({
    type: 'express',
    country,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: { name: displayName },
    metadata: { platform_display_name: displayName },
  })
  const state = toSellerState(acct, displayName)
  store.upsert(state)
  return state
}

/**
 * Adopt an account that already exists — e.g. one you onboarded by hand in the
 * Dashboard. Useful because the interesting states (in review, capabilities
 * paused, requirements outstanding) are easier to produce there than to fake.
 *
 * ⚠ Accounts created through the Dashboard today are provisioned on Stripe's
 * **Accounts v2** model — you can spot them by `Configurations: Merchant /
 * Customer` in the UI. The v1 retrieve below still returns them, but some v1
 * fields can be absent, which is exactly why toSellerState() defaults every
 * boolean rather than trusting the payload. Do not "fix" those `?? false`s.
 */
export async function importExistingSeller(accountId: string, displayName?: string) {
  const acct = await stripe.accounts.retrieve(accountId)
  const state = toSellerState(acct, displayName ?? acct.email ?? accountId)
  store.upsert(state)
  return state
}

/**
 * Account Links are SINGLE USE and expire within minutes. Never store one,
 * never email one — regenerate on demand. That is exactly what refresh_url is for.
 */
export async function createOnboardingLink(accountId: string) {
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${config.appUrl}/onboarding/refresh?account=${accountId}`,
    return_url: `${config.appUrl}/onboarding/return?account=${accountId}`,
    // eventually_due = collect everything up front. currently_due = collect the
    // minimum now and more later. Up-front trades conversion for fewer surprises.
    collection_options: { fields: 'eventually_due' },
  })
  return link.url
}

/** Always re-read from Stripe. Our cache is an optimisation, never the authority. */
export async function refreshSeller(accountId: string) {
  const acct = await stripe.accounts.retrieve(accountId)
  const state = toSellerState(acct)
  store.upsert(state)
  return state
}

/**
 * The destination charge.
 *
 * Funds flow: the full amount is charged on the PLATFORM, immediately transferred
 * to the connected account, and then application_fee_amount is transferred back
 * to the platform. Stripe's fee is then debited from the PLATFORM's balance —
 * which is why config.ts refuses to boot on a fee below ~2%.
 *
 * on_behalf_of makes the connected account the settlement merchant. It changes the
 * statement descriptor, the address the buyer sees, the settlement currency and the
 * Checkout branding. It matters most cross-border: without it, a DK platform selling
 * for a DE seller settles in the platform's country and can pick up an FX conversion.
 */
export async function createCheckoutSession(params: {
  accountId: string
  productName: string
  amountMinorUnits: number
  currency: string
}) {
  const { accountId, productName, amountMinorUnits, currency } = params

  const seller = store.get(accountId)
  if (!seller) throw new Error(`Unknown seller ${accountId}`)

  // Refuse rather than let Stripe fail opaquely at payment time.
  const fresh = await refreshSeller(accountId)
  if (!fresh.chargesEnabled) {
    throw new Error(
      `Seller ${accountId} cannot accept payments yet ` +
      `(charges_enabled=false, currently_due=[${fresh.currentlyDue.join(', ')}]). ` +
      `Send them back through onboarding.`
    )
  }

  const fee = applicationFeeAmount(amountMinorUnits)

  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: amountMinorUnits,
        product_data: { name: productName },
      },
    }],
    payment_intent_data: {
      application_fee_amount: fee,
      transfer_data: { destination: accountId },
      on_behalf_of: accountId,
      metadata: { seller_account: accountId },
    },
    success_url: `${config.appUrl}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.appUrl}/?canceled=1`,
  })
}
