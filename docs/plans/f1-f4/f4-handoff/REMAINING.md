# Remaining work — current partial checkpoint

**This is an implementation and verification backlog, not a request to change the preserved checkpoint during delivery.** Exact source and line anchors are in `reviews/backend.md` and `reviews/ui.md`. Their scope limitations also remain applicable: this quick review does not establish that unmentioned paths are complete or correct. Use reconciled NIM-2937's T1–T18 matrix for full F4/I0 completion.

## 1. Finish the real execution-chat/native production path

### B1 — Compose service, owner, authorization and exact admission

- Construct/inject `WorkflowExecutionChatService` and the existing coordinator's `workflowChatOwner` into production; the optional route/MCP registration currently has no production service.
- Supply actual attachment authorization and SQL-only `validateAdmission` against the complete final native prompt and actual serialized Main/Worker command envelope before persisting a receipt.
- Connect the saved `workflowConsultationPromptLocked` helper, including bounded child facts and memory digest, and persist/reuse the exact final `nativePrompt` on first dispatch and recovery. Remove reliance on the incomplete fallback for this path. Do not allocate managers or perform native/Worker I/O inside the transaction.

### B2 — Compose consultation credentials, preflight and process lifetime

- Use actual consultation issue/restore/renew methods and the exact consultation binding in production; complete normal MCP preflight and credential revocation/source-cleanup separation.
- Allocate cold consultations under `consultation:${consultationId}`, not the completed source's execution owner; keep a resident reviewer's real original lifetime when rebinding it.
- Restore the exact retained environment/token for active-query recovery. Preserve no graph-result/response authority for consultation credentials and actual read-only/selected-tool constraints.

### B3 — Complete Worker/Main transport and exact authority

- Finish qualified remote command/consultation contracts, serializers, native proxy, installed Worker host/journal and ACK correlation. The current include set does not change `runs/remote/{nativeManagerProxy,executionHost,ownerControl,ownerControlAdmission}.ts` or shared `executionAuthority.ts`.
- Carry exact durable command/consultation authority through Main's checks while preserving grants, installation, connection/boot, placement, Run, dispatch and original native owner pins. Keep the control command correlation distinct from the active input correlation.
- Support consultation subject rebinding and separate terminal/history retention without overwriting the original immutable workflow result. Local qualified SingleWriter methods already exist; continue from them.

## 2. Fix the concrete native retention and recovery defects

### B4 — Main reviewer retention must honor durable control disposition

At the actual Main authority offer, reject retention for every nonordinary control disposition, including reserved/admitted/failed/canceled continuations and completed unqueued Stop. A coordinator-side check alone is insufficient. Preserve original native/domain evidence and require positive physical settlement before the exact same-work successor `input.bind`.

### B5 — Preparation-failure cleanup and promoted mailbox input

The preparation-failure catch currently discards `failCoordinatorConsultationPreparationLocked`'s promoted next admission and leaves the old in-memory owner/context. Complete cold and resident manager cleanup/restoration, browser and credential lifetime handling, and dispatch of the promoted next reply. After capture, retain closure obligations until positive native proof. Cover failure before issue, after browser preparation, after rebind/attach, after capture, and during Stop/restart.

### B6 — Reconcile interrupted native interfaces

The unannotated consultation start object's `instructionsDelivered: true` widens to `boolean` while the native interface requires literal `true`. Preserve the correct literal/compatible annotation and finish the interface reconciliation before compiler qualification. This is a static finding; no compiler was run and it is not an exhaustive compile-error list.

Also finish/review negative-successor behavior, final queued-input close, Stop with/without queue, native late success/cancel/unknown outcomes, same-slot successor reservation/admission and ready-child-barrier versus consultation arbitration. Those paths received only selective review and need actual race/recovery evidence.

## 3. Finish public backend and native regression sources

The durable-control service handoff reports its dedicated suite unauthored; the quick review did not find a new public execution-chat/control/consultation suite or the required actual Main-authority regression. Complete these using the real public services, authenticated HTTP/MCP, migrated persisted fixtures and actual installed host/proxy seams:

- Direction release: first genuine receipt reaches the already-held same-Run execution once; command replay does not release/redispatch; an old source cannot be retargeted; SSE root cursor advances while child-report revision remains fixed.
- Qualified Codex steer including same-mode Plan, qualified Claude interrupt-and-send, attachments-only input, exact full-envelope byte admission, command replay/conflict, read-only/disabled-tool and scope denial.
- Reservation/supersession against old native success/late callbacks, no early F1 or parent settlement, exact one successor, preparation failure and restart.
- Queue one/all cancellation, Stop with/without queue, completed Stop versus late success, TARGET_SETTLING/TARGET_SETTLED, Stop Run, unknown transport outcome and genuine ACK/closure.
- Consultation active/reserved-next/normal queue versus ready graph, cold/warm/Stop recovery, immutable prompt, credential issue/restore/renew/revoke, browser late prepare/pending release and source-cleanup separation.
- Actual Main reviewer retention across ordinary success, normalized failure/cancellation, every nonordinary control disposition and reply-gap recovery; original session/result preserved without duplicate effects.
- Bounded native/receipt pages, complete serialized envelopes, exact historical provenance, authorized pagination and cursor reuse rejection; unmarked historical compatibility.

Existing hierarchy/runtime/result/F1 repair/Worker fixture test files remain authored and unrun. Preserve their coverage; do not treat their presence as successful validation of these missing paths.

## 4. Finish four mounted UI journeys and their independent review

1. **Authenticated direction-release stream:** complete the first bullet above using actual `WorkflowExecutionChatService.deliver` / authenticated Send and the real owner. Root-final/Stop/history SSE and same-report/new-cursor tests already exist, but do not cover actual direction delivery.
2. **Combined conflict recovery:** exercise graph/hierarchy edits, staged Agents and raw Agent/hierarchy/create/removal/Worker-parent choices together through conflict, Inspect latest, refresh, repeated conflict, manual reapply and fresh Save. The real mounted recovery test currently changes workflow names; separate helper/form tests do not establish the combined journey.
3. **Canonical saved Run and hidden native child continuity:** finish actual `WorkflowBoard → RunBoardSlot` hierarchy/history/pins/layout/one-rail tests, Show/Hide Workers and View team/All teams navigation, and retained native-subagent composer/pending-command behavior across hidden views, access loss and parent collapse. Source is saved coherently; standalone canvas and legacy-wrapper tests are insufficient.
4. **Real supplied F3 factory/client:** exercise `createWorkflowExecutionChatSlot` with supplied `ExecutionChat`/`OutsideRunChat` views and the actual HTTP boundary: exact Run/execution/waiting pinning, explicit ambiguity selection, no successor auto-selection, refresh/access failure retention and visible-only reads/subscriptions. The saved fake-slot URL test covers only the shell.

U1–U6 and K1–K6 have source implementations, as detailed in the UI review. Do not restart those features from the older hierarchy handoff. Complete review of the full authoring/default/replay/removal transformations and all consumer paths; source presence is not a clean verdict.

## 5. Complete peer integration, full review and authorized qualification

- Compose actual A/F1, B/F2 and C/F3 exports at the agreed phase, verify selected-tool/read-only subject routing and transactional F1 boundaries, and finish shared registry/native/Worker/shell integration without duplicating peer modules.
- Keep production result-protocol enforcement **OFF** until all producer/parser/proof/repair/acceptance paths and actual F1/native integration are complete. Hierarchy Start is currently gated. Enable only the agreed server-pinned new-Run cutover when ready; preserve old Run/version/result bytes.
- Independently review the complete integrated D change and resolve material findings through the relevant owner, including full migration DDL, engine/proof paths and authority/race invariants that were outside this bounded pass.
- Perform the user's authorized verification on the final exact source, then full F4/I0 public scenarios, compatibility and same-computer performance acceptance. No tests, build, compiler, lint, native/product run or performance result is supplied by this archive. Existing release requirements remain separate from this delivery-only checkpoint.

## Short fresh-team checklist

- Finish production execution-chat/full-envelope admission and consultation credentials, process lifetime, Worker transport and Main authority.
- Fix reviewer retention, consultation failure cleanup/next-reply dispatch and the interrupted native type/interface mismatch; finish control/queue/barrier races.
- Add the missing public HTTP/MCP/control/consultation/security/native-authority regressions.
- Finish authenticated direction SSE, combined recovery, canonical saved-Run/hidden child continuity and real supplied-chat-factory UI regressions/review.
- Integrate A/B/C, obtain a complete independent review, then perform authorized final verification and F4/I0 acceptance; keep protocol cutover OFF until ready.
