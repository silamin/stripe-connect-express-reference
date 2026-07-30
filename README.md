# Stripe Connect — Express accounts, destination charges, application fees

[![CI](https://github.com/silamin/stripe-connect-express-reference/actions/workflows/ci.yml/badge.svg)](https://github.com/silamin/stripe-connect-express-reference/actions/workflows/ci.yml)

**Live:** https://stripe-connect-express-reference.onrender.com — test mode, free tier, so
the first request after an idle period takes ~30 s to wake.

A small, deliberately readable reference integration. It exists to cover four specific
things end-to-end, because those four are exactly what gets asked about in interviews
and proposals:

1. **Express connected accounts** — Stripe-hosted onboarding, platform-controlled payouts
2. **Destination charges** — charge on the platform, funds settle to the seller
3. **Application fees** — the platform's cut, and where Stripe's own fee actually lands
4. **Onboarding state** — the part almost everyone gets wrong

Built against Stripe's own documentation (`/connect/express-accounts`,
`/connect/destination-charges`, `/connect/marketplace/tasks/app-fees`), not from memory.

---

## ⛔ What you have to do yourself, and why

**I did not touch your API keys, and I won't.** Handling keys or credentials is a hard
line. This app reads `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from the environment
and nothing else; `config.ts` refuses to boot unless each one has the *shape* of a real
secret — right prefix, alphanumeric body, plausible length. It also refuses a `sk_live_` or
`rk_live_` key outright. The same applies to enabling Connect on the account — that's a
settings change on your own Stripe account and it's yours to make.

> **Why shape and not a placeholder blacklist.** The first version of this guard listed the
> placeholder spellings it knew about, and so was silently fine with every new one. It let
> `whsec_TEMPORARY_replace_after_first_deploy` through — the placeholder this file's own
> deploy section tells you to use — and the server came up clean and then rejected every
> real Stripe event as a signature failure. A checker that enumerates what *fails* can
> always be got round by a value nobody thought of. This one enumerates what passes.

Three steps, all in **test mode**, roughly ten minutes:

1. **Enable Connect.** Dashboard → **Connect** → *Get started*. Choose **Platform or
   marketplace**. This is a one-time activation on your existing `Silamin` account.
2. **Set the Connect branding.** Dashboard → **Settings → Connect → Onboarding interface**.
   Stripe requires a business name, colour and icon before hosted onboarding will render.
   Skipping this is the most common reason the onboarding link 404s on first try.
3. **Copy your test keys.** Dashboard → **Developers → API keys** (make sure the *Test
   mode* toggle is on — the key must start `sk_test_`).

---

## Run it

```bash
npm install
cp .env.example .env          # then paste your own sk_test_… into .env
npx stripe listen --forward-to localhost:4242/webhook   # prints the whsec_… → .env
npm run dev
```

Open http://localhost:4242.

**The flow to walk through, in order:**

- Create a seller → you're redirected into Stripe's hosted Express onboarding.
- Use Stripe's test data: SSN `000-00-0000`, any DOB over 18, address `address_full_match`,
  test bank `DK5000400440116243`. Or click **Skip this form** to leave onboarding
  *deliberately incomplete* — do this at least once, it's the interesting case.
- Come back and look at the seller card. **Three separate booleans, on purpose.**
- Take a payment with card `4242 4242 4242 4242`.
- Watch the terminal: `account.updated`, `checkout.session.completed`,
  `application_fee.created`.

---

## The four things this actually demonstrates

### Onboarding state — there is no single "done" field
Stripe's docs are explicit: the `return_url` redirect *"doesn't mean that all information
has been collected... It only means the flow was entered and exited properly."*

So `/onboarding/return` **ignores the redirect** and re-reads the account from Stripe. A
seller can take money only when all three of these hold — `store.ts:canAcceptPayments()`:

```
charges_enabled === true
details_submitted === true
requirements.currently_due.length === 0
```

And it keeps changing *after* onboarding: Stripe raises new requirements on live accounts,
which is why `account.updated` is a permanent subscription, not a setup step.

### Destination charges — the platform pays Stripe's fee
The full amount is charged on the platform, transferred to the seller, and then
`application_fee_amount` is transferred **back** to the platform. Stripe's fee is then
debited from the **platform's** balance.

⇒ **If your application fee is smaller than Stripe's fee, you lose money on every sale.**
`config.ts` refuses to start below 2% for exactly this reason. That guard is the single
most useful line in the repo.

### `on_behalf_of` — cross-border, and easy to omit
Set to the connected account, it makes the seller the *settlement merchant*: their
statement descriptor, their address, **their settlement currency**. Without it a Danish
platform selling for a German seller settles in the platform's country and can pick up an
avoidable FX conversion.

### Capabilities must be requested
`card_payments` and `transfers` are requested explicitly at account creation. Omit them and
you get the nastiest failure mode here: onboarding completes, the account looks healthy,
and `charges_enabled` never flips — because nothing ever asked.

### One ordering bug worth knowing
The webhook route is mounted **before** `express.json()`. Signature verification needs the
raw body; if the JSON parser runs first, every signature fails with an error that never
mentions body parsing.

⚠ **And "a bad signature returns 400" does not prove this.** It returns 400 either way —
the request is rejected whether the raw body survived or not. The mount order is only
proved by the *positive* case: a **validly** signed payload must be **accepted**, and a
validly signed payload mutated by one byte in transit must be **rejected**. Both are in the
suite, and moving `express.json()` above the route makes them fail while the bad-signature
tests stay green. See below.

### Webhooks arrive at least once
Stripe retries on non-2xx and can deliver the same event more than once. The
`account.updated` handler is idempotent by construction — it *overwrites* cached state from
the event payload rather than mutating it incrementally — so redelivery converges instead
of drifting. That is a property worth pinning rather than assuming, because the obvious
"improvement" (counting, appending, incrementing) would quietly break it. There is a test.

---

## Verified, not asserted

```bash
npm run check      # typecheck + tests
```

**30 tests, no network, no Stripe key required** — the suite drives the real Express app
with supertest and signs its own webhook payloads locally, so it runs on a fork's pull
request where review actually happens.

| What it pins | Why it exists |
|---|---|
| All three onboarding conditions, each failing alone | The `return_url` trap: `charges_enabled` and `details_submitted` both true, one outstanding requirement, and the next payment fails |
| `toSellerState` defaults every boolean on a sparse payload | Accounts v2 accounts can come back through the v1 retrieve with fields absent; `?? false` must stay a decision, not a coincidence |
| A validly-signed webhook is **accepted** and lands in the store | The half a bad-signature test cannot reach |
| A signed-then-mutated payload is **rejected** | The only test that actually proves the raw body survived the middleware |
| Redelivery of the same event is idempotent | Stripe delivers at least once |
| Application fee floors, and never exceeds the charge total | It is money |
| Boot refuses a live key, a sub-2% fee, and every placeholder shape | Each refusal is a claim about money or safety |

These were checked by **mutation**, not by watching them go green: moving `express.json()`
above the webhook route fails 4 tests, and dropping `currently_due` from the gate fails 2.
A test that cannot fail is documentation with a green tick on it.

---

## ⚠ One finding you should know before you talk about this

While reading Stripe's own docs, several pages carry this banner:

> *"Deprecated feature — The information on this page applies only to platforms that
> already use legacy connected account types (Standard, Express, or Custom accounts). If
> you're setting up a new Connect platform... see the Interactive platform guide."*

**Express, Standard and Custom are Stripe's *legacy* account model.** New platforms are
steered to the **Accounts v2 API** with controller properties, where onboarding state is
read from `configuration.*.capabilities.*.status` and the event is
`v2.core.account[requirements].updated` rather than `account.updated`.

This build deliberately targets **v1 Express** — because that's what an existing client's
integration will be on, and it's what you'd be asked to work in. But knowing that v2 exists
and that v1 is legacy is a better answer than either half alone.

---

## Deploying it, for the live link

Any single host works — Railway, Render, Fly, an Azure App Service. Two requirements:

- **Live mode requires HTTPS** on `return_url` / `refresh_url`. HTTP is test-mode only.
- Set the same env vars, and point a Dashboard webhook endpoint at `https://<host>/webhook`
  subscribed to `account.updated`, `checkout.session.completed`, `application_fee.created`.

Keep it in **test mode** for a public demo. A demo in live mode is a liability, not a flex.

---

## How to describe this honestly

It is a working reference integration you built and ran, covering Express onboarding,
destination charges, application fees and onboarding-state tracking, with the funds-flow
and fee-liability consequences understood. **It is not production tenure**, and it should
never be described as such — least of all to a client who has paid for Stripe architecture
review. Said accurately, it's strong: most people answering that question cannot point at
running code at all.
