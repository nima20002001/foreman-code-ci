# Canonical native artifact delivery

`DistributedArtifactPublicationService.publishAccepted` commits a verified transfer through
Main's existing allocation/publication/finalization ledger. It retains the original receipt
for lost-ACK retries; transfer completion alone is not a published native result.

The artifact MCP endpoints are stateless exchanges with a single JSON reply.
Each request authenticates the caller and checks the accepted attempt before
publication or revision-pinned readback; the worker relay reads the complete reply.

`CanonicalNativeArtifactResults.readAccepted(accepted, commandId)` is the Main-only HRT
result/adoption port. Mount it with the same file service, distributed publication ledger,
and accepted-attempt authority as publication. Supply the original persisted native
identity and publication command, never worker-provided execution ownership. It returns
exact publication identity, original native session/turn/message identity, file/revision/hash/size
pins, canonical file metadata and the
original verified receipt only after canonical bytes and current authority are checked.
The original transfer staging may already have expired; canonical file retention still
applies. Pending, missing, corrupt, expired or foreign results throw instead of returning
empty attachments or text-only success. Readback needs `files.list`; it does not allocate,
republish or adopt, and remains usable for an accepted read-only result reader.

HRT must adopt these pins through its existing durable native-message/execution receipt
and preserve the same adoption key on retry. W08 must persist the accepted output-key to
these publication/pins before `ArtifactEdgeService.pinAccepted`; downstream dispatch and
`readAccepted` always consume that exact revision. This module does not invent an
output-key mapping, native completion fact, adoption receipt or DB authority.

HRT owns common/runtime/worker mounts. Integration owns exports, persistence integration,
DB checks and actual two-host native/CI acceptance. The focused file-backed tests exercise
publication ACK loss, transfer expiry, canonical corruption and readback identity without
launching a physical native harness.

Focused verification (run the normal scheduler in the approved host PID namespace):

```sh
node scripts/heavy-job.mjs --timeout-ms 240000 -- sh -c 'corepack pnpm --filter @foreman-code/contracts build && corepack pnpm --filter @foreman-code/api exec vitest run test/canonical-native-artifacts.test.ts test/distributed-artifacts.test.ts src/modules/byte-transfer/service.test.ts src/modules/byte-transfer/sender.test.ts src/modules/byte-transfer/carrier.test.ts --maxWorkers=2'
node scripts/heavy-job.mjs --timeout-ms 240000 -- sh -c 'corepack pnpm --filter @foreman-code/api exec eslint src/modules/files/distributed/nativeResults.ts test/canonical-native-artifacts.test.ts --max-warnings 0 && corepack pnpm --filter @foreman-code/api exec tsc --noEmit'
```
