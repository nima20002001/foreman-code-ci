# W08-A placement admission handoff

Wire schema/protocol version is 1. Unknown versions reject; the v0 checkpoint
refers to the interface milestone, not a permissive wire version.

The canonical `deviceIdentity` host reference is main or device. Device pins
include W07 worker installation, key and authorization revisions. Harness
installation IDs belong to HRT and must not be confused with worker installation
IDs. HRT runtime contract remains version 1. Native manager ownership must compare
host reference, original main installation and immutable binding hash.

`SavedNodePlacement` belongs to the immutable saved workflow node. Public Start
continues to accept version/configuration/location pins rather than runtime JSON.
The internal `RunPlacementAdmissionPort` loads those exact saved records and
obtains authenticated W07 destination and W09 materialization evidence outside
SQL/graph locks. The validation port must verify attestation signatures, host,
registration, root allowlist, canonical symlinks, directory identity, execute/read
and required write access. Passing unchecked worker JSON to this port violates
the contract. Destination revalidation is required before native submission.

`AgentPlacementProducer` loads the immutable saved version/configurations and resolves
actual W09 approved source/root pins plus W07 registration and HRT instance/profile
facts. Unplaced local workflows retain the original admission path. Placed nodes
require explicit saved source/root references; no newest-source selection is inferred.
Accepted source is tagged `pending` with null materialization facts. The accepted
binding freezes source/root/configuration/harness/profile/qualification references.
`insertAcceptedPlacements` runs inside the existing Run/canonical/command receipt
transaction. SQL-only live fences repeat before COMMIT.

After a node becomes eligible, `RepeatRunRepository.insertExecution` invokes the
placement callback inside the same owner/input-admission transaction. The producer
creates a separate native owner grant and immutable operation/attempt intent; native
directory setup remains forbidden there. Only after known admission COMMIT does
`AgentExecutionPreparation` call W09 to copy the exact approved bytes. Its actual
root and child CWD descriptor attestations become a separate `NativeExecutionPlacement`,
adopted with the W09 final binding on the original owner transaction before native entry.
The immutable initial intent keeps the accepted node hash. Its separate native hash
covers receipt/reservation/source/CWD facts and excludes mutable source state and final
adoption bookkeeping. A later source state update never rewrites accepted facts.

Lazy occurrence dispatch derives only from accepted pins. `insertDispatchIntent`
uses the existing Run owner/session fence and transaction, checks persisted
placement, and persists an exact operation/attempt. SQL constraints correlate
canonical repeat execution, occurrence, technical attempt and input digest.
The caller must invoke this in execution admission's existing transaction and
publish wakeup only after a known COMMIT. Intent membership grants no native-entry
permission: retain the existing one-use native entry guard, live authorization
and on-host path checks. Dispatch claims/native owner grants are separate from
the persisted main scheduler session fence.

Migration 284301 is additive and intentionally rejects historical evidence
backfill: placement rows require a newly inserted Run in the same transaction;
new intents require that execution's admission transaction. Immutable rows have
update/delete/truncate guards. Integrate the migration index before enabling
placement admission. No migration invents placement, attestation or observation
for existing Runs. Read legacy missing evidence as `legacy_missing`; retain a
verified original main installation when one exists. Never use today's selected
computer to infer historical runner-local placement.

Shared files belong to the orchestrator/HRT owners. External patches are:
`w08-a-shared-contracts.patch` (export and saved node placement),
`w08-a-admission.patch` (Start seam), and `w08-a-runtime-context.patch` (HRT-B).
Production composition, W07 authenticated filesystem endpoint/W09 attestations,
owner-grant validation, worker submission/control and full HTTP/MCP denied/readback
checks are W08-C/B integration gates, not proved by this lane's unit fixtures.

Focused commands from the lane worktree:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts exec tsc -p tsconfig.build.json
corepack pnpm --filter @graphql/api exec tsc --noEmit
corepack pnpm --filter @graphql/api exec eslint src/modules/placement src/infrastructure/nodePlacementMigration.ts test/node-placement.test.ts test/node-placement-transaction.test.ts --max-warnings 0
corepack pnpm --filter @graphql/api exec vitest run test/node-placement.test.ts test/node-placement-transaction.test.ts --maxWorkers 1
```

Orchestrator integration must prove migration SQL, exact replay after saved edits,
concurrent save/registration/root drift, faults before and after Run/intent COMMIT,
canonical receipt/intent completeness, schedule/repeat/continuation compatibility
and native authorization. The real two-host bytes and process evidence gate,
including uncertain ACK recovery without replacement execution, remains required.


The resumed producer is mounted through `RepeatStartPublication.placementAdmission`
and the existing repository services `admitPlacementExecutionLocked` /
`preparePlacementExecution`. Both manual and schedule publication wrappers must
preserve the placement admission field. HRT-C owns their production constructor
mount; Root owns migration/export integration. Migration 284302 adds actual native
owner grants and finalized source bindings, without historical backfill.

`execution-authority-v1` is a private W07 worker-to-main request namespace. Its
main handler reads exact persisted dispatch/placement, current root/source/profile,
live accepted Run authority, device identity, native owner grant and original
connection. Start additionally requires the existing committed entered native
reservation. Successful replies issue no permit, allocation or lease. Its separate
`read-facts` request returns the genuine adopted clone, immutable Agent configuration,
exact host override/profile/installation and persisted native qualification. Worker
clients reject binary payloads and identity drift. Native qualification requires
exact resolved-launcher SHA/current suite/observed version/target profile/positive
checks and a real check date; baseline or installer expectations are not proof.
The compatibility lookup supports Codex. Claude requires its separate
Claude proof schema rather than a fabricated compatibility qualification.
