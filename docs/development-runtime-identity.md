# Local server reuse

`corepack pnpm dev` reuses an API only when its checkout fingerprint, configured database target fingerprint, and persisted database installation UUID match. The UUID lives in `application_installation`, created by migration 264403; recreating the application database creates a new UUID even at the same database URL. Passwords, usernames, connection query parameters, and filesystem paths are not returned by identity endpoints.

`/health/identity` provides opaque startup evidence; `/api/runtime/identity` provides the same contract under the normal API authentication hook for browser state isolation. Neither endpoint is execution readiness. Identity responses disable caching.

The Vite development endpoint `/__graphql_dev_identity` reports the checkout fingerprint and effective API target. Startup checks both, so an old frontend targeting a different API port cannot be reused. `FOREMAN_CODE_BROWSER_ORIGIN` and `FOREMAN_CODE_WEB_PORT` select the browser address. Conflicting or older servers fail with an actionable message; startup never terminates a pre-existing server. Stop the intended process explicitly or select unused ports. Processes started by this invocation still receive normal cleanup on failure.

Focused checks: `node --test scripts/dev-identity.test.mjs` and `corepack pnpm --filter @foreman-code/api exec vitest run test/runtimeIdentity.test.ts`.
