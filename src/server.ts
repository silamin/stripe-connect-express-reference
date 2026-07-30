import express from 'express'
import type Stripe from 'stripe'
import { config } from './config.js'
import { store, canAcceptPayments } from './store.js'
import {
  stripe, createExpressSeller, createOnboardingLink, importExistingSeller,
  refreshSeller, createCheckoutSession, toSellerState,
} from './connect.js'

const app = express()

/* ------------------------------------------------------------------ *
 * WEBHOOK FIRST — and this ordering is not stylistic.
 * Signature verification needs the RAW body. If express.json() runs first
 * it consumes the stream and every signature check fails with a message
 * that does not mention body parsing. Mounted before the JSON parser.
 * ------------------------------------------------------------------ */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'] as string,
      config.webhookSecret,
    )
  } catch (err) {
    console.error('[webhook] signature verification failed:', (err as Error).message)
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`)
  }

  switch (event.type) {
    // The one that actually matters. Onboarding state changes here — not at
    // return_url — and it keeps changing long after onboarding "finishes",
    // because Stripe can raise new requirements on a live account at any time.
    case 'account.updated': {
      const acct = event.data.object as Stripe.Account
      const state = toSellerState(acct)
      store.upsert(state)
      console.log(
        `[webhook] account.updated ${acct.id} ` +
        `charges=${state.chargesEnabled} payouts=${state.payoutsEnabled} ` +
        `details=${state.detailsSubmitted} due=[${state.currentlyDue.join(',')}]` +
        (state.disabledReason ? ` disabled=${state.disabledReason}` : '')
      )
      break
    }
    case 'checkout.session.completed':
      console.log(`[webhook] checkout completed ${(event.data.object as Stripe.Checkout.Session).id}`)
      break
    case 'application_fee.created': {
      const fee = event.data.object as Stripe.ApplicationFee
      console.log(`[webhook] application_fee.created ${fee.amount} ${fee.currency} from ${fee.account}`)
      break
    }
    // Worth listening for even in a demo: it is how you find out a payout to a
    // seller bounced, which is invisible from the charge side.
    case 'payout.failed':
      console.log(`[webhook] payout.failed on connected account ${event.account ?? 'platform'}`)
      break
    default:
      break
  }
  res.json({ received: true })
})

app.use(express.json())
app.use(express.static('public'))

app.get('/api/sellers', async (_req, res) => {
  const sellers = store.all().map(s => ({ ...s, canAcceptPayments: canAcceptPayments(s) }))
  res.json(sellers)
})

app.post('/api/sellers', async (req, res, next) => {
  try {
    const { displayName, country } = req.body as { displayName?: string; country?: string }
    if (!displayName) return res.status(400).json({ error: 'displayName is required' })
    const seller = await createExpressSeller(displayName, country || 'DK')
    const url = await createOnboardingLink(seller.accountId)
    res.json({ seller, onboardingUrl: url })
  } catch (e) { next(e) }
})

app.post('/api/sellers/import', async (req, res, next) => {
  try {
    const { accountId, displayName } = req.body as { accountId?: string; displayName?: string }
    if (!accountId?.startsWith('acct_')) return res.status(400).json({ error: 'accountId must start with acct_' })
    res.json(await importExistingSeller(accountId, displayName))
  } catch (e) { next(e) }
})

app.post('/api/sellers/:id/onboarding-link', async (req, res, next) => {
  try { res.json({ url: await createOnboardingLink(req.params.id) }) } catch (e) { next(e) }
})

app.get('/api/sellers/:id', async (req, res, next) => {
  try {
    const s = await refreshSeller(req.params.id)
    res.json({ ...s, canAcceptPayments: canAcceptPayments(s) })
  } catch (e) { next(e) }
})

app.post('/api/checkout', async (req, res, next) => {
  try {
    const { accountId, productName, amount, currency } = req.body as
      { accountId: string; productName: string; amount: number; currency?: string }
    const session = await createCheckoutSession({
      accountId,
      productName: productName || 'Demo item',
      amountMinorUnits: Math.round(amount),
      currency: (currency || config.defaultCurrency).toLowerCase(),
    })
    res.json({ url: session.url })
  } catch (e) { next(e) }
})

/* The honest half of the redirect pair. The return_url tells us NOTHING about
 * whether onboarding succeeded — so we ignore the redirect and go ask Stripe. */
app.get('/onboarding/return', async (req, res, next) => {
  try {
    const id = String(req.query.account ?? '')
    const s = await refreshSeller(id)
    res.redirect(`/?returned=1&account=${id}&ready=${canAcceptPayments(s) ? '1' : '0'}`)
  } catch (e) { next(e) }
})

/* Link expired, was reused, or was previewed by a link-unfurling client.
 * Mint a new one with the same parameters and send them straight back in. */
app.get('/onboarding/refresh', async (req, res, next) => {
  try { res.redirect(await createOnboardingLink(String(req.query.account ?? ''))) } catch (e) { next(e) }
})

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err.message)
  res.status(400).json({ error: err.message })
})

// Pull the pre-existing sandbox account in on boot so the first screen shows real
// state rather than an empty list. Never fatal — a bad or foreign id must not stop
// the server, it must just say so.
async function seed() {
  if (!config.seedAccountId) return
  try {
    const s = await importExistingSeller(config.seedAccountId)
    console.log(
      `▸ Seeded ${s.accountId} (${s.displayName})  ` +
      `charges=${s.chargesEnabled} payouts=${s.payoutsEnabled} details=${s.detailsSubmitted}` +
      (s.currentlyDue.length ? `  due=[${s.currentlyDue.join(',')}]` : '')
    )
    if (!s.chargesEnabled) {
      console.log('▸ NOTE: charges_enabled is false — this account cannot be paid yet.')
      console.log('▸ That is the state this demo exists to show. Use "Continue onboarding" to clear it.')
    }
  } catch (e) {
    console.log(`▸ Could not seed ${config.seedAccountId}: ${(e as Error).message}`)
    console.log('▸ Most likely cause: the key and the account are in different environments')
    console.log('▸ (a sandbox account is invisible to a live key, and vice versa).')
  }
}

app.listen(config.port, () => {
  console.log(`▸ Connect reference running on ${config.appUrl}`)
  console.log(`▸ Platform fee: ${config.platformFeeBps / 100}%  (platform pays Stripe's fee on destination charges)`)
  console.log(`▸ Currency:   ${config.defaultCurrency.toUpperCase()}`)
  console.log(`▸ Webhooks:  stripe listen --forward-to localhost:${config.port}/webhook`)
  void seed()
})
