# Stripe Connect — Express accounts, destination charges, application fees

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
and nothing else; `config.ts` refuses to boot if they're absent or still say `REPLACE_ME`.
The same applies to enabling Connect on the account — that's a settings change on your own
Stripe account and it's yours to make.

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
mentions body parsing. Verified: posting a bad signature returns `400`.

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
