import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'
import { canAcceptPayments, type SellerState } from '../src/store.js'
import { toSellerState } from '../src/connect.js'

/**
 * The headline claim of this repo: there is no single Stripe field meaning
 * "onboarding is done". These tests exist so that claim is checkable by
 * someone who has not read the README.
 */

function seller(overrides: Partial<SellerState> = {}): SellerState {
  return {
    accountId: 'acct_test',
    displayName: 'Test seller',
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    currentlyDue: [],
    disabledReason: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('canAcceptPayments — all three conditions are load-bearing', () => {
  it('accepts only when charges_enabled AND details_submitted AND currently_due is empty', () => {
    expect(canAcceptPayments(seller())).toBe(true)
  })

  it('refuses when charges_enabled is false', () => {
    expect(canAcceptPayments(seller({ chargesEnabled: false }))).toBe(false)
  })

  it('refuses when details_submitted is false', () => {
    expect(canAcceptPayments(seller({ detailsSubmitted: false }))).toBe(false)
  })

  /**
   * THE RETURN_URL TRAP, pinned.
   *
   * This is the state a team ships by accident: the seller completed the hosted
   * flow, Stripe bounced them back to return_url, charges_enabled and
   * details_submitted are both true — and there is still an outstanding
   * requirement, so the next payment fails. Treating the redirect as success
   * produces exactly this row.
   */
  it('refuses when requirements.currently_due is non-empty, even though the other two are true', () => {
    const s = seller({ currentlyDue: ['individual.verification.document'] })
    expect(s.chargesEnabled && s.detailsSubmitted).toBe(true)
    expect(canAcceptPayments(s)).toBe(false)
  })

  it('refuses on a freshly created account, where nothing is collected yet', () => {
    expect(canAcceptPayments(seller({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      currentlyDue: ['business_type', 'external_account'],
    }))).toBe(false)
  })
})

describe('toSellerState — every boolean defaults to false on a sparse payload', () => {
  /**
   * Accounts provisioned on Stripe's Accounts v2 model can come back through the
   * v1 retrieve with fields absent rather than false. `undefined` is falsy, so a
   * missing field would read as "not enabled" by accident — but `?? false` makes
   * that a decision instead of a coincidence, and keeps the stored type honest.
   * connect.ts says "Do not fix those ?? false's". This test is why.
   */
  it('maps an account with no capability fields at all to all-false, not undefined', () => {
    const sparse = { id: 'acct_sparse' } as Stripe.Account
    const state = toSellerState(sparse, 'Sparse account')

    expect(state.chargesEnabled).toBe(false)
    expect(state.payoutsEnabled).toBe(false)
    expect(state.detailsSubmitted).toBe(false)
    expect(state.currentlyDue).toEqual([])
    expect(state.disabledReason).toBeNull()
    expect(canAcceptPayments(state)).toBe(false)
  })

  it('carries requirements.currently_due through so the gate can see it', () => {
    const acct = {
      id: 'acct_due',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: ['external_account'], disabled_reason: null },
    } as unknown as Stripe.Account

    const state = toSellerState(acct, 'Pending seller')
    expect(state.currentlyDue).toEqual(['external_account'])
    expect(canAcceptPayments(state)).toBe(false)
  })
})
