# F4 part 1 — independent bounded backend source review

## Verdict and exact snapshot

**PARTIAL SOURCE CHECKPOINT — material unfinished integration remains; not CLEAN, build-qualified, runtime-qualified, or accepted F4.** This review supports preserving the saved work in the requested immediate partial archive. It is not a reason to discard unfinished source or to delay that archive for implementation work.

Reviewer: `/root/f4_part1_backend_review`, independent of the source authors. Reviewed the packager's immutable candidate at `/workspace/scratch/944f8012e664/f4-part1-frozen/changed-files/`, against base `003775c1e2cfb3f1616a9b3bfb8cbba7289ff7e1` (base tree `a8721bc0e5c556d101667ef440ce54cbb521c613`). The frozen `INVENTORY.json` SHA-256 was independently read as:

`05e326d1aca6037a26e4793e76c3426dbdda169731129bb556d582e8fa61f5c5`

The packager inventory contains **253 changed paths: 104 added, 149 modified, zero deletions**. Its per-file hashes identify the exact postimages. No live-worktree edits after this freeze are covered. No old review approval is extended to this snapshot.

Read the repository `AGENTS.md`, cached NIM-2937 governing precedence/scope, reconciled result-protocol and control/consultation requirements, and lanes §§2 and 7. The exact plan reference supplied for this checkpoint is `efcc0fe565843c7c3aaf45ed835591d855b0f656`. The reconciled issue/shared decisions govern earlier feature proposals. Existing D ownership covers the inspected paths; no inspected source was identified as an A/B/C-exclusive edit.

**Only static reads, searches, Git inspection and byte hashing were used.** No product source was edited. No tests, builds, compiler, lint, formatter, migration, native process, product execution, package install or remote write was performed. This was deliberately a quick material-risk pass, not a full completeness audit of 253 files.

## Material findings and exact continuation tasks

### B1. Public execution chat and admission are not composed in production

`apps/api/src/app.ts:210` registers execution-chat routes only when `options.operator.services.executionChat` exists. The saved `production.ts` has no construction/injection of `WorkflowExecutionChatService` and no call to `ApprovalExecutionCoordinator.workflowChatOwner`. The coordinator's owner factory exists at `modules/interactions/execution.ts:873–893`; the domain service and route/MCP adapters have substantial saved implementation.

`modules/collaboration/workflowChatAdmission.ts:60–71` calls `owner.validateAdmission` before inserting the durable command and can persist an immutable `nativePrompt`. That is the correct seam, but no production implementation is supplied. `workflowConsultationPromptLocked` exists at `modules/collaboration/workflowConsultationPrompt.ts:11–65` and has no caller in the frozen changed sources. The native owner still falls back to a text/reference-only prompt when the snapshot is absent (`modules/interactions/workflowChatOwner.ts:116`; `execution.ts:1007`).

**Impact:** the new public capability is not available through normal production composition. Wiring it with an incomplete validator would admit receipts before the actual complete Main/Worker serialized envelope is checked and could omit the consultation's frozen bounded child facts/digest.

**Continue:** construct/inject the existing service and owner; supply actual attachment authorization and SQL-only admission validation; form/check the full immutable final prompt and actual transport envelope before receipt insertion; reuse those exact saved bytes on dispatch/recovery. Do not allocate managers or perform native/Worker I/O inside admission. The prompt builder, owner, records and adapters should be completed and connected, not rewritten as a second service/owner.

### B2. Consultation credential, preflight and process-lifetime production wiring is unfinished

The consultation-aware owner calls credential `prepare(... purpose: 'consultation', consultation: binding)` and separate restore/renew methods (`execution.ts:1048–1078`). The saved credential interfaces and access service already contain consultation support. Production still:

- allocates a native process scope as `execution:${context.executionId}` (`production.ts:1314`);
- constructs credential preparation context without `input.consultation` (`production.ts:1505–1509`);
- chooses only reviewer versus ordinary execution issuance for Claude (`production.ts:1530`);
- has no `restoreConsultation` or `renewConsultation` implementation in `launchCredentials` (`production.ts:1466–1572`);
- requires an execution-owned launch scope (`production.ts:1598–1604`).

The resolver now keys cold consultations separately (`modules/interactions/runtimePorts.ts:59–71`), but this alone does not change production process ownership or credential authority.

**Impact:** consultation prepare/recovery cannot use the intended exact subject and retained credential through the real production path. A cold consultation process would still share the completed source execution's process-owner namespace, contrary to the separate-lifetime requirement; source cleanup could affect it if that path were enabled as-is.

**Continue:** compose actual `issueForConsultation`, `restoreForConsultation`, `renewForConsultation` and normal MCP preflight using the exact binding; reserve cold process scope as `consultation:${consultationId}` while preserving a resident reviewer's actual original lifetime on rebind. Complete credential revocation/source-cleanup separation and recovery without token replacement for an active query.

### B3. Worker transport and exact Main control authority remain at the old interface

The included local adapter work adds qualified SingleWriter controls and consultation session variants, but the frozen inventory does not change `runs/remote/{nativeManagerProxy,executionHost,ownerControl,ownerControlAdmission}.ts` or `packages/contracts/src/executionAuthority.ts`. Read-only inspection of those baseline dependencies confirms:

- `nativeManagerProxy.ts:375–389` permits only original execution/result-repair or assigned review correlations; a `consultation:...` turn is rejected.
- `ownerControl.ts:29–45` authorizes Stop only for existing cleanup, failed-attempt or retained-reviewer cases, not a durable workflow chat Stop/interrupt command.
- the execution authority request schema exposes no exact workflow-control or consultation binding.
- included `modules/placement/executionAuthority.ts:90–91` still rejects ordinary active Stop without cleanup/failure/retained-reviewer authority.

**Impact:** Main-only helper changes do not supply actual Worker steering, exact ordinary Stop/interrupt, consultation replay/history/terminal storage or consultation subject rebinding. The new native session variant is not yet an end-to-end transport implementation.

**Continue:** finish qualified remote command and consultation contracts/serializer, proxy, installed Worker host/journal, actual ACK correlation and exact Main authority checks. Keep control command correlation distinct from the original active input. Persist consultation terminal/history separately from the immutable original workflow result. Preserve grants, installation, connection/boot, Run, dispatch and native identity checks; do not solve the gap with a broad authority bypass.

### B4. Retained-reviewer offers do not yet honor permanent control disposition at Main authority

`modules/placement/executionAuthority.ts:159–167` derives a reviewer offer from `remoteReviewerPolicy` and normalized execution state/outcome, but never consults `readWorkflowControlDispositionLocked`. The latter correctly treats all retained continuations and completed unqueued Stops as permanent fences (`modules/collaboration/workflowControlDisposition.ts:12–26`). A check is present in a coordinator retention branch (`execution.ts:529–530`), which does not substitute for the actual Main authority offer consumed by Worker settlement.

**Impact:** an otherwise successful original execution can still receive a Main reviewer offer after a reserved/admitted/failed/canceled control continuation or completed Stop supersedes it. That can retain the old process when physical closure is required before a same-work successor.

**Continue:** reject reviewer retention for every nonordinary durable control disposition at the real Main authority boundary. Preserve original native/normalized bytes, and require physical settlement before successor `input.bind`. Add the actual Main-authority/installed-Worker regression for ordinary success, normalized failure/cancellation, every nonordinary disposition and reply-gap recovery. Existing proof/Worker fixture tests are not evidence for this omitted Main path.

### B5. Consultation preparation-failure cleanup loses the promoted next reply and leaves the old owner entry

`execution.ts:1035–1044` handles an admitted pre-capture preparation failure by releasing browser state, revoking the credential and calling `failCoordinatorConsultationPreparationLocked`. That function returns the next promoted admission (`modules/collaboration/workflowConsultations.ts:228–255`). The caller discards the return value, does not dispatch the next reply, and does not call `releaseConsultationEntry` or restore/dispose the previous manager context. By comparison, normal completion does release the entry and dispatch next (`execution.ts:1023–1025`; entry restoration/release is at `1086–1098`).

**Impact:** the mailbox can promote a next consultation while the source's in-memory entry remains bound to the failed old consultation; a subsequent start can reject it as another consultation still owning the source (`execution.ts:972–973`). A partially started cold manager or a paused/rebound reviewer also lacks complete failure cleanup here.

**Continue:** finish bounded preparation-failure cleanup for both cold and resident paths, restore/release the exact manager and credential lifetime, retain positive closure obligations after capture, and dispatch the transaction's promoted next admission. Cover failure before credential issue, after browser preparation, after rebind/attach, after capture and during Stop/restart through public behavior.

### B6. A newly saved consultation start has a static literal-type mismatch

`execution.ts:990–998` stores `start` as an unannotated object with `kind: 'workflow-consultation' as const` but `instructionsDelivered: true` without literal preservation, then passes it to the native start interface. `modules/harnesses/port.ts:107–115` requires `instructionsDelivered: true` as a literal. The mutable object's property is inferred as `boolean`, so this source needs an explicit compatible type/literal before compiler qualification. This is a static type observation, not a compiler result or an exhaustive compile-error list.

**Continue:** reconcile the interrupted interface changes and then run the user's chosen verification outside this delivery-only task. Do not interpret the archive as compile-ready.

## Saved behavior observed, without runtime approval

- `SingleWriterSessionManager.steerQualified` and `cancelQualified` exist (`sessionWriter.ts:763–813`). They compare the exact captured lease/provider correlation before and after acquiring the existing control queue, invoke the caller fence inside that queue, and check the returned steer turn. This is saved work, not an unstarted task.
- `workflowChatOwner.ts:95–121` records unknown-before-offer and only marks steering accepted after the native turn acknowledgement; cancel ACK does not itself settle the successor.
- `execution.ts:896–918` captures actual lease/provider identity and the separately retained active session mode rather than inferring mode from `SessionPreferences`.
- `workflowChatInput.ts:6–11` gives attachments-only sends nonempty exact file/revision reference text. Attachment authorization and full-envelope admission still require B1.
- The consultation prompt helper, separate mailbox settlement/preparation-failure APIs, credential subject validator and cold/Stop recovery source are saved. They require integration/failure-path completion, not a fresh architecture.
- `workflowCollaborationRuntime.ts:59–65` fences native result effects for superseded/stopping attempts. Negative-successor/group/queue-close paths received only a selective read; no full race or invariant approval is given.

## Protocol admission remains OFF

`repeatStartAdmission.ts:348–359` explicitly leaves new-Run result-protocol enforcement off and returns `HIERARCHY_RESULT_PROTOCOL_UNAVAILABLE` for a saved hierarchy until shared result/F1 integration. The prompt/parser/proof and marked fixture work does **not** imply production cutover. This readiness behavior is a saved partial-state limitation, not completed F4 acceptance. Continue real F1 callbacks and peer composition before enabling the server-pinned marker; preserve existing unmarked Run/version/result facts.

## Verification and exact remaining backend work

Focused source exists for hierarchy/runtime, result protocol, F1 effect repair and Worker result settlement. Selected test cases call public APIs/fixtures and inspect outputs/durable readback. They were not run. This pass did not find a newly authored public execution-chat/control/consultation suite, matching the control-service author's explicit handoff. The required Main authority regression is also not present in the frozen include inventory. A complete test review was not performed.

Fresh-team continuation, in concise terms:

1. Finish production execution-chat/owner wiring, attachment authorization and immutable full-envelope admission.
2. Finish consultation credential/preflight/process-scope wiring and Worker/Main transport/authority; preserve original session and separate transcript/result storage.
3. Fix Main reviewer retention fences and require physical settlement before same-work successor input.
4. Complete consultation cold/warm/Stop recovery, preparation-failure cleanup and next-mailbox dispatch; resolve interrupted native interface/type integration.
5. Finish negative successor, final queue close, Stop-with/without-queue and ready-child-barrier races through the existing owner/transactions.
6. Author/complete public HTTP/MCP/Run/control/consultation/security/native-authority regressions, then perform authorized verification. No verification result is claimed here.
7. Integrate peer F1/F2/F3 exports and all transactional F1 boundaries before result-protocol cutover and full F4/I0 acceptance.

## Reviewed scope and limitations

The following frozen paths received substantive source inspection, with selective sections for larger files. This list is tied to the inventory hash above; per-file SHA-256 values are in `INVENTORY.json` and `POSTIMAGES.sha256`.

- `apps/api/src/app.ts` — execution-chat registration condition only.
- `apps/api/src/production.ts` — collaboration, manager allocation, credential/preflight, launch-scope and service-injection seams.
- `apps/api/src/modules/access/consultationAuthority.ts` — exact mailbox/credential subject validation.
- `apps/api/src/modules/collaboration/workflowChatAdmission.ts` — send/stop/cancel admission.
- `apps/api/src/modules/collaboration/workflowChatService.ts` — service dependencies, dispatch/auth/receipt handling.
- `apps/api/src/modules/collaboration/workflowConsultationPrompt.ts` — complete bounded prompt helper.
- `apps/api/src/modules/collaboration/workflowConsultations.ts` — consultation settlement, preparation failure and mailbox promotion.
- `apps/api/src/modules/collaboration/workflowControlDisposition.ts` — complete permanent disposition fence.
- `apps/api/src/modules/harnesses/port.ts` — consultation and qualified-control types.
- `apps/api/src/modules/harnesses/consultationSession.ts` — complete session/rebind validation helper.
- `apps/api/src/modules/harnesses/mcpDetection.ts` — credential purpose/provider interface.
- `apps/api/src/modules/harnesses/codexAppServer/controls.ts` — native control/rebind context, selective.
- `apps/api/src/modules/harnesses/claudeSdk/sessionManager.ts` — native forwarding composition.
- `apps/api/src/modules/harnesses/claudeSdk/sessionOpening.ts` — consultation attach/create/fork/rebind branches, selective.
- `apps/api/src/modules/interactions/execution.ts` — retained-reviewer disposition, exact native capture, consultation start/settlement/failure/recovery and frozen prompt submission, selective.
- `apps/api/src/modules/interactions/runtimePorts.ts` — resolver ownership/keying.
- `apps/api/src/modules/interactions/sessionWriter.ts` — lease and qualified controls/rebind forwarding.
- `apps/api/src/modules/interactions/workflowChatOwner.ts` — complete owner/control adapter.
- `apps/api/src/modules/interactions/workflowChatInput.ts` — complete input/reference prompt construction.
- `apps/api/src/modules/interactions/workflowConsultationObserver.ts` — targeted correlation/capture/terminal search; not a complete observer proof.
- `apps/api/src/modules/placement/executionAuthority.ts` — Main authority and reviewer offer.
- `apps/api/src/modules/runs/repeatStartAdmission.ts` — protocol/readiness admission.
- `apps/api/src/modules/runs/workflowCollaborationRuntime.ts` — lifecycle/result suppression.
- `apps/api/src/modules/runs/hierarchyGroupSettlement.ts` — negative-member/barrier ownership, selective.
- `apps/api/src/modules/runs/remote/workerCoordinationSettlement.test.ts` — public fixture settlement assertions, selective.
- `apps/api/test/workflow-board-effect-repair.integration.test.ts` — case inventory only.
- `apps/api/test/workflow-hierarchy-runtime.integration.test.ts` — case inventory only.
- `apps/api/test/workflow-result-protocol.integration.test.ts` — case inventory only.

Baseline-only dependency reads: `runs/remote/{nativeManagerProxy,ownerControl,ownerControlAdmission,executionHost}.ts` and `packages/contracts/src/executionAuthority.ts`. These were inspected to establish the transport/authority mismatch, not included as modified postimages.

All other changed backend files, full migration DDL, complete engine producer/parser/proof paths, complete credential implementations and all race/denied-scope cases remain **unreviewed or only search-scanned in this quick pass**. UI/shared hierarchy authoring/HTTP SSE/UX review is owned by the separate reviewer. No blanket clean verdict should be inferred from this note.
