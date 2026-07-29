# Apex MUN 2026 — Backend Setup & Deployment

This project contains the full site (`index.html`) plus a secure serverless
registration API (`api/register.js`). Deployed together on Vercel, delegates
submit the form on your site and it's handled entirely by your own backend —
no more Formspree.

## What happens on submission

1. `api/register.js` receives the POST request and rejects anything from bots
   (a hidden honeypot field) or with invalid/missing data.
2. Claude (Anthropic API) reads the delegate's essay and returns a score out
   of 10 plus a short academic note.
3. The full record — including the AI score — is appended as a new row in
   your Google Sheet.
4. An email is sent to the delegate's first-choice committee inbox
   (`unsc@…`, `unhrc@…`, `disec@…`) with a copy to `admin@apexmun.com`.

If the AI step fails, the application is still saved (score just comes back
empty) — a flaky AI call should never lose a real application. If the Sheet
write fails, the applicant gets an error and can retry (so no data silently
disappears).

---

## 1. Google Sheet (database)

1. Create a new Google Sheet. Rename the first tab to `Applications`.
2. In row 1, add headers (order matters — matches what the code writes):
   `Timestamp | Full Name | Email | Phone | Experience | First Choice | Second Choice | Essay | AI Score | AI Note`
3. Copy the Sheet ID from its URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
4. Go to [Google Cloud Console](https://console.cloud.google.com/) → create
   a project (or reuse one) → enable the **Google Sheets API**.
5. Go to **IAM & Admin → Service Accounts → Create Service Account**. Give it
   any name (e.g. `apex-mun-sheets`). No special role needed.
6. Open the new service account → **Keys → Add Key → Create new key → JSON**.
   Download the file.
7. Open your Google Sheet → **Share** → paste the service account's email
   (looks like `...@...iam.gserviceaccount.com`, found in the JSON file) →
   give it **Editor** access.
8. From the JSON file, you need two values for your environment variables:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (paste exactly as-is, including
     the `\n` sequences)

## 2. Resend (email routing)

1. Create a free account at [resend.com](https://resend.com).
2. Add and verify your domain (`apexmun.com`) under **Domains** — this
   requires adding a couple of DNS records with your domain registrar.
   Verification usually takes a few minutes to a few hours.
3. Create an API key under **API Keys** → this is your `RESEND_API_KEY`.
4. Set `FROM_EMAIL` to an address on your verified domain, e.g.
   `registrations@apexmun.com`.
5. Make sure `unsc@apexmun.com`, `unhrc@apexmun.com`, `disec@apexmun.com`,
   and `admin@apexmun.com` are real inboxes (or forwarding rules) — Resend
   only sends the email, it doesn't create the mailbox for you.

   *Don't have a domain yet?* Resend also gives you a sandbox sender for
   testing before your domain is verified — fine for development, not for
   real delegate traffic.

## 3. Claude API (essay evaluator)

1. Create a key at [console.anthropic.com](https://console.anthropic.com) →
   **API Keys**.
2. That's your `ANTHROPIC_API_KEY`. The function calls the `claude-sonnet-5`
   model — cheap and fast enough for a per-submission classification task.

## 4. Deploy to Vercel

```bash
cd apex-mun-app
npm install
npx vercel login          # opens a browser to authenticate your account
npx vercel                # first deploy — creates the project, asks a few questions
```

Then add every variable from `.env.example` with your real values:

```bash
npx vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
npx vercel env add GOOGLE_PRIVATE_KEY
npx vercel env add GOOGLE_SHEET_ID
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add RESEND_API_KEY
npx vercel env add FROM_EMAIL
npx vercel env add ADMIN_EMAIL
```

(Or paste them into the Vercel dashboard → your project → **Settings →
Environment Variables** — same result, no CLI needed.)

Redeploy so the function picks up the new variables:

```bash
npx vercel --prod
```

Your site + API are now live on the same domain — the form's
`action="/api/register"` already points at the right place, nothing else to
change.

## 5. Test it

Open the live site, fill out the registration form with a throwaway test
essay, and submit. Check:
- A new row appeared in the Google Sheet (with an AI score).
- The committee inbox and `admin@apexmun.com` both received the email.

If something fails, check **Vercel → your project → Deployments → Functions
→ Logs** — every failure is logged with a specific reason (bad Sheets auth,
bad Resend key, etc.).

## Security notes

- All secrets live only in Vercel's environment variables — never in the
  client-side HTML/JS.
- Every field is re-validated server-side (never trust what the browser
  sends), independent of the front-end's own validation.
- A hidden honeypot field silently discards basic spam-bot submissions.
- **Rate limiting is not implemented.** Serverless functions are stateless,
  so a real rate limiter needs an external store (e.g. Upstash Redis +
  `@upstash/ratelimit`). Worth adding before the form gets wide public
  traffic — ask if you'd like this wired up.
