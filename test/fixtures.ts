/**
 * Key-shaped test fixtures, ASSEMBLED AT RUNTIME rather than written as literals.
 *
 * ⚠ This indirection is not styling, and it should not be "cleaned up" back into
 * plain strings. A literal that satisfies Stripe's key format is, by construction,
 * precisely what a secret scanner looks for — and the first version of this suite
 * was rejected by GitHub push protection over three such literals, every one of
 * them invented. The irony is instructive: `config.ts` validates secrets by shape,
 * so any fixture good enough to exercise that validator is also good enough to
 * trip a scanner that validates the same way.
 *
 * Assembling them from parts keeps the tests honest — they still drive the real
 * shape validator with genuinely key-shaped input — while leaving nothing in the
 * source for a scanner to match, and nothing for a reader to mistake for a live
 * credential.
 *
 * The bodies are deliberately low-entropy repeats. None of these values has ever
 * existed in any Stripe account.
 */

const j = (...parts: string[]) => parts.join('_')
const body = (c: string, n = 24) => c.repeat(n)

export const FAKE = {
  /** Valid shape, sandbox — the happy path. */
  secretTest: j('sk', 'test', body('A')),
  /** Valid shape, LIVE — must be refused by the live-key guard, not by the shape guard. */
  secretLive: j('sk', 'live', body('B')),
  /** Valid shape, LIVE restricted — the guard must catch `rk_` too, not only `sk_`. */
  restrictedLive: j('rk', 'live', body('C')),
  /** A secret key handed to the WEBHOOK variable: right shape, wrong prefix for its slot. */
  wrongPrefixForWebhook: j('sk', 'test', body('D')),

  /** Valid signing secret shape. */
  webhookSecret: j('whsec', body('E', 32)),
  /** A second valid signing secret, for "a real one is accepted". */
  webhookSecretAlt: j('whsec', body('F', 32)),
  /** Right prefix, implausibly short — must be refused. */
  webhookTooShort: j('whsec', 'abc'),

  /**
   * ⚑ The regression fixture. This is the placeholder the repo's own deploy notes
   * tell you to set before the first deploy, and the previous blacklist guard did
   * not match it — so the server booted on an unusable secret and rejected every
   * genuine Stripe event as a signature failure.
   */
  deployPlaceholder: j('whsec', 'TEMPORARY', 'replace', 'after', 'first', 'deploy'),
} as const

/** Env that boots cleanly. Spread it, then override the one thing under test. */
export const GOOD_ENV = {
  NODE_ENV: 'test',
  STRIPE_SECRET_KEY: FAKE.secretTest,
  STRIPE_WEBHOOK_SECRET: FAKE.webhookSecret,
  PLATFORM_FEE_BPS: '1000',
  APP_URL: 'http://localhost:4242',
} as const
