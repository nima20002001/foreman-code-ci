# PR 10 audit integration handoff

This branch consolidates all eight audit bundles on PR 10's audited commit
`2f83f40b2249a35d8a67389ef6e353006c18a311`. Its PR targets
`feat/nim-2601-hap-05`; it does not update PR 10 or any other HAP branch.

## Source provenance

| Agent | Findings | Original handoff commit |
| --- | --- | --- |
| 8 — persistence/audit | 27, 30 and shared recovery storage | `4f0088a0dd9786b0fc1f0234ccf7c04817cd8791` |
| 7 — credentials/lifecycle | 22, 24, budget/credential portion of 28 | `a1e31a4d10be659f05c7ce9779dfe3df4010f9ad` |
| 5 — reviewer/session lanes | 15–19 | `fb6cb54e8575685b1efe3e782fb60571509c0ac7` |
| 4 — native observation | 4, 5, 14, 25, 26, 32 | `23cf3b003d596bc669b64f16ffc817b5029c7897` |
| 2 — delivery/resume intent | 7, 8, 10–12, delivery portion of 28 | `abbd63ffdc3b2004cda856fa228dbde4c8c8f622` |
| 3 — graph lifecycle | 3, 6, 9, 21, 29 | `d16b6a66931b97da9482c690dde64c9e56def692` |
| 6 — Stop/shutdown | 13, 20, 23, 31 | `dd7c8bc99da06246aaad585df3c27ea88c7a2eb8` |
| 1 — production/auth | 1, 2 and production exposure for 15 | `5e8eb4b1cccf6c19917cca131e4a79e7dda34901` |

Seven source commits have the exact audited head as their parent. Agent 6 used a
partial snapshot with a synthetic parent; its patch was applied to real PR
ancestry using a three-way merge. Its synthetic history was not merged.
Bundle/object integrity and changed-file boundaries were checked before import.

## Integration corrections

- Migration 503 and the independently authored 508 originally defined incompatible
  graph-resume tables. There is now one table: 508 extends 503's identity-bearing
  record and uses its pending/resuming/resumed/blocked/canceled states. Previously
  applied migration SQL through 502 remains unchanged.
- Delivery dispatch and the persistence recovery APIs share the interaction's
  exclusive delivery fence. Neither API can submit while the other owns the
  response. Expired graph handoffs from either API remain recoverable without
  repeating native work.
- Authorized command receipts are validated even on an already-delivered
  same-option replay, before graph recovery.
- The native writer wrapper preserves the resolver's live residency getter and
  releases the underlying manager identity. Resident checks retain the scoped
  credential and renew its existing token; they do not replace the process.
- PostgreSQL claim/renew timestamps round-trip through the shared contract.
- Workflow and reviewer events retain the durable native-event audit path.
- Exact current graph interrupts can refer to multiple native requests for the
  same execution. Resume queues retain ownership and remaining active budgets.
- Stop observes real attachment completion, including late completion after an
  abort. Cancellation cannot strand closure behind an uncooperative native call.
  Cleanup of a pending attachment still checks its existing database lease.
  A close predating a late attachment is not accepted as final closure evidence.
- Production composes credential renewal, the shared HTTP/Operator/App interaction
  service, paginated delivery recovery, reviewer recovery, and shutdown draining.
  The server listens before recovery that may need the local MCP endpoint.
- Regression fixtures now supply the full owner, credential, lease, and audit
  contracts. Coordinator tests retain the real writer/lease implementation behind
  an in-memory persistence boundary. App MCP database fixtures have a separate
  schema so incomplete storage fixtures cannot leak into unrelated API tests.

## Review the seams

Review the combined tree and diff from the PR base, including integration changes
after the original agent commits. Prioritize concrete defects in these paths:

1. Delivery → graph resume: persisted native truth, late interrupt binding,
   exact checkpoint identities, lost acknowledgement, and harmless completed replay.
2. Stop versus response: budget-row ordering, delivery ownership, cancellation
   signals, cleanup failures, and preventing a later provider mutation.
3. Native managers/credentials: allocation versus residency, failed preflight,
   expiry after long approval waits, safe renewal, and exact-session recovery.
4. Workflow/reviewer writers: shared lanes, real designated reviewer ownership,
   lease renewal/loss, authoritative terminal evidence, and crash recovery.
5. Graph/cleanup: normal interrupts, concurrent resumes, sibling task ownership,
   excluded wait time, abort-before-drain, and late native completion.
6. Production/auth: verify real startup constructs every service used by tests;
   preserve distinct User, Operator, and Orchestrator authority.

Do not repair uncertainty by replaying a native response or turn, impersonating a
different handler, widening permissions, removing audits, or disabling fences.
Provider histories that cannot prove the addressed result must remain uncertain.
Return findings against the exact reviewed PR head. A follow-up fix bundle should
target that head and preserve unrelated edits; consolidation into PR 10 comes
after the review/fix round.

## Local verification

Verification uses pinned Corepack/pnpm and local PostgreSQL; GitHub CI is not a gate.
The final integrated source passed repository typecheck, lint, build, 626 unit
tests (43 contracts, 222 web, 361 API; one existing API test skipped), all 62
PostgreSQL/HTTP/MCP integration tests, the real Codex/OpenCode workflow acceptance
test, and the production-start smoke test. Earlier integration failures were
resolved; the counts describe the final combined source rather than the bundle
authors' isolated checks.

Run from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm test:integration
corepack pnpm test:acceptance
corepack pnpm test:production
```

Integration and acceptance use fresh disposable databases, with
`TEST_DATABASE_URL` and `DATABASE_URL` pointing to the test database. The existing
shared PostgreSQL container is left running for other worktrees.

The suites include real PostgreSQL locking/transactions, HTTP/MCP transport,
real LangGraph tests, and the existing authenticated Codex/OpenCode workflow
acceptance test. Deterministic native managers exercise failure and race cases;
the existing live-provider acceptance test is not exhaustive proof of native
permission/restart/reviewer behavior across every provider version. No browser
E2E was added; this integration changes backend behavior and backend fixtures.
