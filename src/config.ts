import 'dotenv/config'

/**
 * Secrets are validated by SHAPE — what a real value looks like — not by
 * blacklisting placeholder spellings.
 *
 * The blacklist this replaces was `/REPLACE_ME|PASTE_|_HERE$|^sk_test_REPLACE|
 * ^whsec_REPLACE/i`, and it had the defect every blacklist has: it enumerated
 * the ways a value could be WRONG, so each new placeholder spelling was silently
 * fine. It missed `whsec_TEMPORARY_replace_after_first_deploy` — the exact
 * placeholder this repo's own deploy notes tell you to use — which meant the
 * server booted happily with an unusable webhook secret and then rejected every
 * real Stripe event as a signature failure. That is precisely the opaque
 * downstream failure the guard existed to prevent.
 *
 * Stripe's keys and signing secrets are a prefix plus an alphanumeric body, so
 * "starts with the right prefix and the rest is alphanumeric and long enough"
 * accepts every real value and rejects anything hand-written — including
 * placeholders nobody has thought of yet.
 */
const SECRET_SHAPES: Record<string, { pattern: RegExp; looksLike: string }> = {
  STRIPE_SECRET_KEY: {
    pattern: /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/,
    looksLike: 'sk_test_… (Dashboard → Developers → API keys, with the sandbox selected)',
  },
  STRIPE_WEBHOOK_SECRET: {
    pattern: /^whsec_[A-Za-z0-9]{16,}$/,
    looksLike: 'whsec_… (from `stripe listen`, or the destination\'s signing secret in the Dashboard)',
  },
}

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(
      `Missing env var ${name}. Copy .env.example to .env and fill it in. ` +
      `This app reads keys from the environment only — never from source.`
    )
  }

  const shape = SECRET_SHAPES[name]
  if (shape && !shape.pattern.test(v)) {
    throw new Error(
      `Missing env var ${name}: the value present is not a real secret — it is a ` +
      `placeholder or a typo, so it would fail later as an opaque error from Stripe ` +
      `rather than here.\nExpected something of the form ${shape.looksLike}\n` +
      `This app reads keys from the environment only — never from source.`
    )
  }
  return v
}

const secretKey = required('STRIPE_SECRET_KEY')

// Fail fast on the single most expensive mistake available here: pointing a demo
// at the LIVE account. Sandbox keys start sk_test_ / rk_test_; live keys start
// sk_live_ / rk_live_. Live-mode Connect onboarding collects real identity
// documents and creates real obligations.
if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) {
  throw new Error(
    `STRIPE_SECRET_KEY is a LIVE key (${secretKey.slice(0, 8)}…). Refusing to start.\n` +
    `This is a demo and belongs in a sandbox. In the Dashboard, switch the account\n` +
    `picker (top-left) to your sandbox FIRST, then Developers → API keys, and use the\n` +
    `sk_test_ value. If a live key has ever been pasted anywhere, roll it.`
  )
}

export const config = {
  stripeSecretKey: secretKey,
  webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  appUrl: process.env.APP_URL ?? 'http://localhost:4242',
  port: Number(process.env.PORT ?? 4242),
  platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? 1000),
  seedAccountId: process.env.SEED_ACCOUNT_ID?.trim() || null,
  defaultCurrency: (process.env.DEFAULT_CURRENCY ?? 'dkk').toLowerCase(),
}

// Guard rail, not decoration. On a destination charge the PLATFORM pays the Stripe
// fee out of its own balance; the application fee is the platform's only income.
// Stripe's European card fee is roughly 1.5% + 1.80 DKK, so a fee below ~2% can
// leave the platform net-negative on small transactions. Fail loudly at boot
// rather than discover it in a reconciliation three weeks later.
if (config.platformFeeBps < 200) {
  throw new Error(
    `PLATFORM_FEE_BPS is ${config.platformFeeBps} (${config.platformFeeBps / 100}%). ` +
    `On destination charges the platform pays Stripe's fee, so anything under ~2% ` +
    `risks a negative margin on small payments. Raise it or remove this guard deliberately.`
  )
}

export function applicationFeeAmount(totalMinorUnits: number): number {
  // application_fee_amount is capped at the charge total and is always computed
  // in the charge currency. Round down so the fee can never exceed the total.
  return Math.floor((totalMinorUnits * config.platformFeeBps) / 10_000)
}
