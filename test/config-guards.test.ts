import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { FAKE, GOOD_ENV } from './fixtures.js'

/**
 * config.ts refuses to boot on several separate mistakes. Each refusal is a claim
 * about money or safety, so each one gets a test — otherwise "the guards fire" is
 * something you can only find out by making the mistake.
 *
 * Note the shape of these tests: the assertion is that `import` THROWS. That is
 * deliberate. These checks run at module load, so a misconfigured process does not
 * start at all rather than starting and warning.
 *
 * ⚠ Every key-shaped value here comes from `fixtures.ts` and is assembled at
 * runtime. See the comment there before replacing any of them with a literal.
 */

const saved = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...saved, ...GOOD_ENV }
  delete process.env.SEED_ACCOUNT_ID
})

afterAll(() => { process.env = saved })

const loadConfig = () => import('../src/config.js')

describe('config guards — the process refuses to start rather than start wrong', () => {
  it('boots with a well-formed test configuration', async () => {
    const { config } = await loadConfig()
    expect(config.platformFeeBps).toBe(1000)
    expect(config.stripeSecretKey).toBe(FAKE.secretTest)
  })

  it('REFUSES a live secret key — a demo must never touch the live account', async () => {
    process.env.STRIPE_SECRET_KEY = FAKE.secretLive
    await expect(loadConfig()).rejects.toThrow(/LIVE key/i)
  })

  it('REFUSES a live RESTRICTED key too, not just the unrestricted one', async () => {
    process.env.STRIPE_SECRET_KEY = FAKE.restrictedLive
    await expect(loadConfig()).rejects.toThrow(/LIVE key/i)
  })

  /**
   * On a destination charge the PLATFORM pays Stripe's fee (~1.5% + 1.80 DKK in
   * Europe) out of its own balance, and the application fee is its only income.
   * Below ~2% the platform can be net-negative on small payments — a loss that
   * surfaces in reconciliation weeks later, not at the point of sale.
   */
  it('REFUSES a platform fee below 2%, because that can be loss-making', async () => {
    process.env.PLATFORM_FEE_BPS = '100'
    await expect(loadConfig()).rejects.toThrow(/negative margin/i)
  })

  it('accepts exactly 2%, the documented floor', async () => {
    process.env.PLATFORM_FEE_BPS = '200'
    const { config } = await loadConfig()
    expect(config.platformFeeBps).toBe(200)
  })

  it('REFUSES a missing secret key', async () => {
    delete process.env.STRIPE_SECRET_KEY
    await expect(loadConfig()).rejects.toThrow(/Missing env var STRIPE_SECRET_KEY/)
  })

  /**
   * ⚑ THE REGRESSION THIS FILE WAS WRITTEN FOR.
   *
   * The previous guard was a blacklist — it matched `REPLACE_ME`, `PASTE_`, a
   * trailing `_HERE` and two prefixes — and this placeholder is none of those. So
   * the server booted cleanly with an unusable signing secret and then rejected
   * every genuine Stripe event as a signature failure: exactly the opaque
   * downstream error the guard existed to prevent.
   *
   * Fixed by validating SHAPE instead of enumerating ways to be wrong. A checker
   * that lists what FAILS is silently fine with every new way of failing.
   */
  it('REFUSES the deploy placeholder that the old blacklist missed', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = FAKE.deployPlaceholder
    await expect(loadConfig()).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/)
  })

  it('REFUSES every placeholder spelling the repo has ever shipped', async () => {
    for (const placeholder of [
      'REPLACE_ME',
      'PASTE_YOUR_KEY_HERE',
      'CHANGEME',
      'your-key-here',
      '',
    ]) {
      vi.resetModules()
      process.env = { ...saved, ...GOOD_ENV, STRIPE_SECRET_KEY: placeholder }
      await expect(loadConfig()).rejects.toThrow(/STRIPE_SECRET_KEY/)
    }
  })

  it('REFUSES a webhook secret carrying the wrong prefix for its slot', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = FAKE.wrongPrefixForWebhook
    await expect(loadConfig()).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/)
  })

  it('REFUSES a secret that is the right shape but implausibly short', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = FAKE.webhookTooShort
    await expect(loadConfig()).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/)
  })

  it('accepts a real-shaped signing secret', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = FAKE.webhookSecretAlt
    const { config } = await loadConfig()
    expect(config.webhookSecret).toBe(FAKE.webhookSecretAlt)
  })
})
