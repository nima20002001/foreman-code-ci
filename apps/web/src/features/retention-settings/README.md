# FIL-41 — Chat retention

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`543c38dff7b5487dae676219477a1bb9c69d6a8e`.

All files in this handoff are additions under this feature directory. No existing
settings page, shared contract, dependency, lockfile, backend or migration is changed.

## Mount

The public export is `ChatRetentionSettings`; it takes no props and requires only
the application's existing `QueryClientProvider` and Nocturne theme/styles.
It does not read a workspace, workflow, selected conversation or router context.

In `apps/web/src/features/settings/LocalAccount.tsx`, add:

```tsx
import { ChatRetentionSettings } from '../retention-settings'
```

Inside the successful authenticated render, within
`<div className="settings-editor-content account-content">`, insert this line after
the Permissions section and before that div's closing tag:

```tsx
<ChatRetentionSettings />
```

This keeps the control in the existing `/account` page, below the permission
information and above the account-actions footer. Mount inside the authenticated
branch, not beside the loading/denied AccountAccess placeholder. The mount edit is
intentionally not included. The new component loads its own scoped stylesheet.

## HTTP and state

`retentionClient.ts` calls the existing `apiClient.request` boundary with the frozen
`@foreman-code/contracts/files` input and result schemas:

- `GET /api/management/file-retention`
- `POST /api/management/file-retention/preview`
- `POST /api/management/file-retention`

The authenticated principal is the only owner selector. No owner, workspace,
workflow, conversation or file ID is sent. Existing API authentication, same-origin
cookies, response validation and session-generation fences remain in force.
The UI supplies no fallback preference: an unset server preference displays seven
days only after the GET returns its duration and revision.

TanStack Query owns preferences, previews and request state. The existing Zustand
`useRevisionedForm` owns the editable snapshot, revision conflicts and exact command
retry. A small protected sessionStorage journal supplements that memory-only helper
solely for outstanding commands across hard reloads. It is not a second server cache:
it retains the shared save input plus the user's number/unit representation, not a
persisted preference. Journal state also uses Zustand; there is no mirrored React
server state. Refs are used only to invalidate obsolete preview continuations.

Durations are converted to integer seconds and validated with the shared one-hour
through 365-day schema. Decimal hours/days are supported when they represent whole
seconds, including round trips of non-whole-hour server values. Display chooses days
when exact, otherwise hours. There is no local-calendar or sliding-expiry arithmetic.

## Save, confirmation and recovery

Save always carries `commandId` and `expectedRevision`. A successful command receipt
is checked against the submitted duration and revision; a fresh GET then supplies the
value shown in the control. A historical replay receipt never replaces a newer current
preference. Existing GETs are canceled before the post-save readback, and preference
cache updates do not regress revisions for the same owner.

Apply to existing is opt-in. Every explicit apply request is previewed, including
extensions: older live files may have longer creation-time retention snapshots than
the current preference. A positive server count opens the shared small Dialog and
requires “Apply and save.” A zero count saves without a redundant confirmation.
The dialog binds to the proposal's duration, owner and preference revision; cancel,
editing, refreshed revisions or unmount invalidate the confirmation/continuation.
The count is an as-of preview, not a reservation. Tooltip text states that it may
change before save. No timer or client-computed expiration count is used.

Edits remain on definitive failures and conflicts. A revision conflict fetches the
latest preference and requires the explicit “Use my value” action before a new Save.
That action only rebases the local draft; it does not write to the server, and the next
apply-to-existing Save obtains a fresh preview.

Automatic mutation retries are disabled, even when the enclosing QueryClient enables
them. Network failures, 5xx responses, malformed acknowledgements and failed GET
readbacks keep the original command unresolved. Input is locked and “Retry save”
replays exactly the same command, expected revision, duration and apply flag, without
another preview or a new logical save. A denied/busy replay cannot disprove an earlier
commit, so it retains that command too; a receipt-aware revision conflict is a definite
resolution. A readback failure after a successful POST is never treated as a rejection
of that POST, including when the GET fails with a structured 4xx.

The journal is written before sending bytes and is cleared only after current readback
or a definitive command rejection. Reload in the same tab restores it only after the
current owner's GET; restoration never automatically sends a request. Its key uses the
existing protected identity epoch and owner, and installation changes isolate
the protected sessionStorage prefix. A changed installation does not adopt an old journal. Storage errors or malformed records fail closed rather than silently
minting a new command. Closing the tab or manually clearing browser storage discards this tab-local recovery state; there is no cross-tab command queue.

The backend remains responsible for ownership, grants, immutable file revisions,
retention application, tombstones and exclusion of permanent references. No local
file metadata or bytes are edited by this component. FIL-40 already exposes the same
get/preview/save service through `file_retention_get`, `file_retention_preview` and
`file_retention_save`. No additional MCP capability is introduced here. The frozen
capability-enum discovery gap reported in `docs/FIL-40-BACKEND.md` is unchanged.

## Accessibility and layout

The section and numeric/unit controls have accessible names, concise live error/status
feedback and keyboard-accessible detail tooltips. Visually hidden field labels avoid
repeating the short heading. Shared Dialog behavior provides focus management, Escape
and backdrop cancellation. Controls lock while work is pending or an outcome is unknown.
The three-column control uses shrinking zero-minimum grid tracks, contained inputs and
small gaps at 390px. Actual browser layout at 390px still needs verification.

## Tests

`ChatRetentionSettings.test.tsx` uses the existing MSW server and the real HTTP client,
not a mocked feature client. It covers the default and non-default readback; save and
cold remount; bounds and integer-second validation; rejected input; explicit conflict
reapplication; positive/zero/error/mismatched/stale previews; shared backdrop cancel;
late preview after unmount; rapid save clicks; lost or malformed acknowledgements;
route-remount and hard-reload recovery; denied replay; failed GET after accepted POST;
newer current GET after an older receipt; failed initial load; unavailable/corrupt
recovery storage; and account-session isolation. There is no workspace/router provider
in the test harness. Strict request parsing rejects accidental scope selectors.

`retentionDraft.test.ts` covers exact duration round trips, decimals, boundaries,
invalid input and confirmation identity binding.

Run in the full pinned checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/web exec node ../../scripts/heavy-job.mjs -- vitest run src/features/retention-settings/ChatRetentionSettings.test.tsx src/features/retention-settings/retentionDraft.test.ts
corepack pnpm --filter @foreman-code/web typecheck
corepack pnpm --filter @foreman-code/web lint
corepack pnpm --filter @foreman-code/web build
```

Then mount and verify the account page at 390px against the FIL-40 backend with its
required migration applied, including preview confirmation and a saved-value reload.
The full repository verification commands in AGENTS.md remain applicable.

## Delivery verification

Actually run: TypeScript **5.8.3** syntax/transpilation checks on all nine added TS/TSX
files, with zero diagnostics; PostCSS parsing of the stylesheet. These are not a
semantic typecheck or runtime tests. Archive path, CRC, byte equality and SHA-256
checks are recorded in the root MANIFEST.txt during packaging.

Not run: Vitest/MSW tests, the repository's TypeScript **5.9.3** semantic check, ESLint,
contracts/web/full build, browser accessibility or 390px layout, live HTTP/MCP,
PostgreSQL/migration integration or acceptance suites. This delivery environment has
only reconstructed source additions, not a full checkout or the web dependencies.
Git checkout could not resolve github.com; bootstrapping the pinned pnpm **11.27.0**
through Corepack failed with registry DNS **EAI_AGAIN**. No substitute package manager,
relaxed package-age policy, stubbed dependency tests or isolated browser was used.
