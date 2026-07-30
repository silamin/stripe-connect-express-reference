import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { FAKE, GOOD_ENV } from './fixtures.js'

/**
 * The webhook tests, and the reason they matter more than the others.
 *
 * Rejecting a BAD signature only proves the route is mounted. It does not prove
 * a GOOD one is accepted, and it does not prove the raw body survived — which is
 * the actual failure this repo is built around. `express.json()` mounted before
 * the webhook route would still reject bad signatures, identically, while
 * breaking every real event Stripe sends.
 *
 * So the load-bearing test here is the third one: a payload signed correctly and
 * then mutated by one byte must fail. That can only pass if the handler verifies
 * against the exact bytes Stripe sent.
 */

const WEBHOOK_SECRET = FAKE.webhookSecret

let app: Express
let stripe: import('stripe').default

beforeAll(async () => {
  process.env = { ...process.env, ...GOOD_ENV }
  delete process.env.SEED_ACCOUNT_ID

  app = (await import('../src/server.js')).app
  stripe = (await import('../src/connect.js')).stripe
})

function signedRequest(body: unknown) {
  const payload = JSON.stringify(body)
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  return { payload, header }
}

const accountUpdated = (account: Record<string, unknown>) => ({
  id: 'evt_test_account_updated',
  object: 'event',
  api_version: '2024-06-20',
  created: 0,
  type: 'account.updated',
  data: { object: account },
})

describe('POST /webhook — signature verification on the raw body', () => {
  it('rejects a bogus signature with 400 and does not process the event', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=not_a_real_signature')
      .send(JSON.stringify(accountUpdated({ id: 'acct_should_not_land' })))

    expect(res.status).toBe(400)
    expect(res.text).toMatch(/Webhook Error/)
  })

  it('rejects a missing signature header with 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(accountUpdated({ id: 'acct_no_header' })))

    expect(res.status).toBe(400)
  })

  /**
   * THE ONE THAT PROVES THE MOUNT ORDER.
   *
   * Sign a payload, then change one character before sending. If the handler is
   * verifying re-serialised JSON rather than the bytes on the wire, this passes
   * and the test goes green for the wrong reason. It must fail.
   */
  it('rejects a correctly-signed payload that was mutated in transit', async () => {
    const { payload, header } = signedRequest(accountUpdated({ id: 'acct_original' }))
    const tampered = payload.replace('acct_original', 'acct_tampered')
    expect(tampered).not.toBe(payload)
    expect(tampered.length).toBe(payload.length)

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(tampered)

    expect(res.status).toBe(400)
  })

  /**
   * THE ONE THE DEPLOYED INSTANCE CANNOT SHOW.
   *
   * A valid signature is accepted, the handler runs, and account.updated
   * actually lands in the store with the onboarding gate applied to it.
   */
  it('accepts a validly-signed account.updated and caches the onboarding state', async () => {
    const { payload, header } = signedRequest(accountUpdated({
      id: 'acct_webhook_ok',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    }))

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })

    const { store } = await import('../src/store.js')
    const cached = store.get('acct_webhook_ok')
    expect(cached).toBeDefined()
    expect(cached!.chargesEnabled).toBe(true)
    expect(cached!.detailsSubmitted).toBe(true)
    expect(cached!.currentlyDue).toEqual([])
  })

  it('caches a NOT-ready account as not ready, rather than assuming success', async () => {
    const { payload, header } = signedRequest(accountUpdated({
      id: 'acct_webhook_pending',
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements: { currently_due: ['individual.verification.document'], disabled_reason: null },
    }))

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload)
      .expect(200)

    const { store, canAcceptPayments } = await import('../src/store.js')
    const cached = store.get('acct_webhook_pending')!
    expect(cached.currentlyDue).toEqual(['individual.verification.document'])
    expect(canAcceptPayments(cached)).toBe(false)
  })

  /**
   * Stripe delivers webhooks AT LEAST ONCE. Redelivery of the same event must
   * not corrupt cached state. This handler is naturally idempotent because it
   * overwrites from the event payload rather than mutating incrementally —
   * worth pinning, because the obvious "improvement" (appending, counting,
   * incrementing) would silently break it.
   */
  it('is idempotent under redelivery of the same event', async () => {
    const { payload, header } = signedRequest(accountUpdated({
      id: 'acct_redelivered',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    }))

    const send = () => request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload)
      .expect(200)

    await send()
    const { store } = await import('../src/store.js')
    const first = { ...store.get('acct_redelivered')! }

    await send()
    await send()
    const third = store.get('acct_redelivered')!

    expect(third.accountId).toBe(first.accountId)
    expect(third.chargesEnabled).toBe(first.chargesEnabled)
    expect(third.currentlyDue).toEqual(first.currentlyDue)
    expect(store.all().filter(s => s.accountId === 'acct_redelivered')).toHaveLength(1)
  })
})

describe('GET /api/sellers — the gate is applied at the edge, not just internally', () => {
  it('reports canAcceptPayments per seller', async () => {
    const res = await request(app).get('/api/sellers').expect(200)
    const ready = res.body.find((s: any) => s.accountId === 'acct_webhook_ok')
    const pending = res.body.find((s: any) => s.accountId === 'acct_webhook_pending')

    expect(ready?.canAcceptPayments).toBe(true)
    expect(pending?.canAcceptPayments).toBe(false)
  })
})
