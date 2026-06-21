# Deploying HedgeAdvisor to Vercel

The app is build-verified and deploy-ready (Next.js App Router, all on-demand against the
public Polymarket API). The actual deploy needs **your** Vercel account, so run the one
command below — I can't publish on your behalf.

## One-time

```bash
npm i -g vercel@latest      # CLI is currently behind; latest recommended
vercel login                # your account
vercel link                 # link this folder to a Vercel project
```

## Environment variables

Set these in the Vercel dashboard (Project → Settings → Environment Variables) or via
`vercel env add`:

| Var | Required? | What it does |
|---|---|---|
| `CRON_SECRET` | **Required if you enable the cron** | Auth for `/api/cron/snapshot`. Auth FAILS CLOSED — if unset, the cron route returns 401 to everyone (Vercel Cron injects this header automatically once set). |
| `DATABASE_URL` | Optional | Neon Postgres for the proprietary price-history moat. Unset → the snapshot cron no-ops; the app still works fully on-demand. |
| `AI_GATEWAY_API_KEY` | Optional | Enables the LLM explanation polish (Vercel AI Gateway). Unset → the deterministic template is used. |
| `HEDGE_DEFAULT_EVENT_SLUG` | Optional | Fallback event for the hedge tool (default `world-cup-winner`). |
| `HEDGE_L2_ENABLED` | **Leave UNSET** | L2 non-custodial execution is legally gated. Do NOT set to `true` without the counsel sign-off in `HedgeAdvisor-Execution-Compliance.md`. |

## Deploy

```bash
vercel            # preview deploy
vercel --prod     # production
```

`vercel.json` already declares the cron (`/api/cron/snapshot`, every minute). It only
runs (and only persists) once `CRON_SECRET` **and** `DATABASE_URL` are set.

## Pre-deploy checklist (all currently green)

- [x] `npm test` — 63 tests pass (honesty invariants, sim regression, resolver, fees)
- [x] `npm run typecheck` — clean
- [x] `npm run build` — clean (routes: `/`, `/plan`, `/api/{hedge,plan,requote,cron/snapshot}`)
- [ ] `CRON_SECRET` set in Vercel (only if enabling the moat cron)
- [ ] Confirm Polymarket commercial/API terms before charging (see compliance doc §7)

## Post-deploy

The app reads the **live** public Polymarket API at request time, so a fresh deploy is
immediately functional (no seeding needed). The history moat starts accruing once the cron
runs against a configured `DATABASE_URL`.
