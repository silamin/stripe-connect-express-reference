import { describe, it, expect, beforeAll } from 'vitest'
import { GOOD_ENV } from './fixtures.js'

/**
 * The application fee is the platform's only income on a destination charge,
 * and the platform pays Stripe's processing fee out of its own balance. Both
 * halves of that are money, so both are pinned here.
 */

let applicationFeeAmount: (total: number) => number

beforeAll(async () => {
  process.env = { ...process.env, ...GOOD_ENV }
  applicationFeeAmount = (await import('../src/config.js')).applicationFeeAmount
})

describe('applicationFeeAmount', () => {
  it('takes the configured basis points — 1000 bps = 10%', () => {
    expect(applicationFeeAmount(10_000)).toBe(1_000)
  })

  it('rounds DOWN, so the fee can never exceed the charge total', () => {
    // 999 minor units at 10% is 99.9 — must floor to 99, not round to 100.
    expect(applicationFeeAmount(999)).toBe(99)
    expect(applicationFeeAmount(1)).toBe(0)
  })

  it('never returns more than the total, at any amount', () => {
    for (const total of [0, 1, 7, 99, 100, 12_345, 1_000_000]) {
      expect(applicationFeeAmount(total)).toBeLessThanOrEqual(total)
    }
  })

  it('is zero for a zero-amount charge rather than NaN', () => {
    expect(applicationFeeAmount(0)).toBe(0)
  })

  it('works in minor units — 45,00 DKK charged is 4,50 DKK of fee', () => {
    expect(applicationFeeAmount(4_500)).toBe(450)
  })
})
