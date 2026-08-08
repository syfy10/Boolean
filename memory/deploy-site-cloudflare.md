---
name: deploy-site-cloudflare
description: How to deploy the marketing site to production (boollm.com/boolean/) on Cloudflare Pages
metadata:
  type: reference
---

The public marketing site (the `site/` folder) is deployed to Cloudflare Pages.

**Production `boollm.com/boolean/` is served by the `boollm` Pages project**, NOT `saz3`. There are two projects on the account (saz3labs@gmail.com):
- `boollm` → boollm.pages.dev, **boollm.com** (production)
- `saz3` → saz3.pages.dev, saz3.com (older/alias)

Deploy command:
```
npx wrangler pages deploy site --project-name boollm --commit-dirty=true
```

Production branch is `main`; a deploy from `main` goes straight to production. Old deploy logs referenced `--project-name saz3`, which is stale — deploying there does NOT update boollm.com.

The cloud backend Worker is separate: `backend/wrangler.jsonc`, name `boolean-cloud`, with routes on `boollm.com/boolean/auth/*` and `/admin*`. See [[boollm-site-redesign]].
