# F4 Part 1 — independent bounded UI/source review

Reviewer: `/root/f4_part1_ui_review`.

**Verdict: partial checkpoint; not CLEAN, not complete F4 acceptance, and not release-qualified.** The quick independent review found the interrupted overlay edit saved coherently and found source implementations for the old U1–U6 repair work and K1–K6 shell additions. Important acceptance and review gaps remain below. This note does not extend any earlier approval to all included files.

No product source was changed. No tests, compiler, build, lint, formatter, native adapter, or product code were executed. Only static source/metadata reads and this review note were produced. Authored tests are unrun.

## Exact reviewed snapshot and authority

- Base commit: `003775c1e2cfb3f1616a9b3bfb8cbba7289ff7e1`.
- Base tree: `a8721bc0e5c556d101667ef440ce54cbb521c613`.
- Plan commit: `efcc0fe565843c7c3aaf45ed835591d855b0f656`; reconciled NIM-2937 takes precedence over older feature prose.
- Read `AGENTS.md`, cached issue/ownership material, `HIERARCHY_HANDOFF.md`, prior UI review findings/limits, and the control-service handoff relevant to the supplied F3 factory seam.
- Reviewed source was read from `/workspace/scratch/944f8012e664/f4-part1-frozen/changed-files/`, not the live editing checkout. The included snapshot contains 253 files (104 added, 149 modified, zero deleted), as reported by the packager.
- `INVENTORY.json` SHA-256 supplied by the packager: `05e326d1aca6037a26e4793e76c3426dbdda169731129bb556d582e8fa61f5c5`. Its per-path postimage SHA-256/base Git OIDs and `POSTIMAGES.sha256` identify the exact reviewed bytes. The packaging agent owns independent inventory/patch/archive integrity checks.
- Ownership boundary agreed with the backend reviewer: this pass covers the UI and hierarchy read/SSE/default staging seams below; backend execution/persistence/native/control/auth acceptance is owned by the backend review. No A/B/C feature internals were implemented or reviewed as complete here. Keep result-protocol enforcement OFF.

## Old findings: what is saved and what still remains

| Prior item | Source observed in frozen snapshot | Remaining limitation |
| --- | --- | --- |
| U1: root changes without child reports | `WorkflowHierarchyService.changes` now computes a bounded repeatable-read fingerprint from Run/head/activity/report revisions, latest root group, canonical coordination state, and relevant execution revisions. SSE publishes changed cursors independently of report revision. Rendered same-report/new-cursor coverage and real authenticated HTTP root-final/Stop stream cases are authored. | The actual public `WorkflowExecutionChatService.deliver` / authenticated Send direction-release case with exact owner delivery remains unauthored. Prove the held execution receives the first real receipt once, replay does not redispatch, the old source cannot be retargeted, and the SSE cursor changes while report revision stays fixed. |
| U2: no-hierarchy fixture | The no-Master rendered fixture now passes `hierarchy: null`. Current/historical no-Master cases remain authored. | Unrun; no executed failure/pass result claimed. |
| U3: new staged Agent role defaults | Creation-only resolution reads saved role templates, preserves explicit empty arrays, and normalizes omitted new-Agent tool defaults before a private intent is retained. Existing Agent paths are excluded by `baseRevision === null`. | Public template/default/replay source exists in the authenticated hierarchy test file; this pass read its relevant locations/test inventory, not every assertion or the full staged publication implementation. Verify the complete persisted replay/default-change behavior locally and in final integration review. |
| U4: real Inspect latest recovery | A rendered WorkflowBoard/MSW test now covers a structural save conflict, retained separate copies, fresh base and command, refresh, explicit discard, storage/latest-read errors, and unknown Stage reconciliation. The save hook retains before latest-read and fences changed active forms. | The real mounted recovery test changes workflow names. It does not yet combine graph/hierarchy edits, staged Agent edits, raw Agent fields, and raw hierarchy/create/removal choices in one conflict → Inspect latest → manually reapply → Save journey. Separate retained-form/helper cases do not establish that complete journey. |
| U5: Worker parent Apply/Cancel | `WorkerParentField` stores the raw parent choice in `workflowForms.workerParents`; `BoardAgentSettings` includes it in dirty/Cancel handling. Apply passes parent/required-route changes through the same `changeDraftAgent` transaction. A real rendered Apply/Cancel/Undo case is authored. | Unrun; the final combined recovery case above must also retain this raw parent selection. |
| U6: earlier report rounds | Explicit Report history lazily mounts a node-specific cursor query, separate from latest direct-child summaries. Selected report state is retained during pagination/live summary invalidation. Rendered history/scroll coverage and HTTP/MCP history over three actual engine business rounds are authored. | Unrun. This is source presence and a bounded review, not an executed pagination/performance result. |

## K1–K6 and interrupted tail

- **K1 removal/replacement:** retained removal dialog, destination/keep choices, atomic Worker move/remove helper path, and explicit previous-Master keep/remove controls are saved. Relevant rendered removal/replacement cases and an authenticated atomic save case are authored. This pass inspected the dialog and targeted helper/form/test locations; it did not give the complete authoring transform a clean independent verdict.
- **K2 team presentation:** Show/Hide Workers controls and URL team selection are saved. View team/All teams are wired into Overview and the canonical canvas. Full actual Board navigation, native-child continuity and composer preservation remain part of the interrupted final regression/review work.
- **K3 row feedback:** immutable Reported timestamps, last-successful-update timestamps on stale reads, and blocked/failed-first stable sorting are present in Overview.
- **K4 saved Run:** canonical `RunBoard`/`RunBoardCanvas` now read exact selected-Run hierarchy, render role/parent metadata, dock details into the existing rail, and gate expensive inspector/CI/subagent bodies while hidden. The saved-coordinate test was updated. The full actual `WorkflowBoard → RunBoardSlot` hierarchy/one-rail/history/hidden-read test remains unfinished; do not substitute legacy `SelectedRunCanvas` coverage or a standalone canvas test.
- **Interrupted subagent edit:** `RunSubagentsOverlay` remains mounted across hidden Graph/Memory states, retains composer text in its owner, disables list/detail/messages/tools reads via `visible`, and makes the `SubagentPanel` body return null when hidden. The saved files have coherent closing source; no truncated tail was observed. This does not prove behavior under actual navigation, access loss, pending commands, or parent Worker collapse; those public regressions remain to finish.
- **K5 workspace Memory:** a separate workspace Memory route/root selection mounts the supplied workspace slot inline. New scoped route/navigation tests are saved, including absence of workflow modal use.
- **K6 Browser profiles:** a distinct Settings destination/filter mounts B's typed slot with an exact Main/device target. Route/filter/back-history/unavailable-target tests are saved. No B browser implementation is supplied by D.
- **Supplied F3 factory:** the typed factory is mounted from `CollaborationUISlots.executionChatViews`; exact execution/waiting-activation URL pins and explicit Run selection callbacks are saved. The new rail test uses an injected fake `executionChat` slot. It does **not** exercise `createWorkflowExecutionChatSlot` with supplied `ExecutionChat`/`OutsideRunChat` views and the real HTTP client. Complete those public regressions for target resolution/pinning, no successor auto-selection, refresh/access failure, and visible-only reads/subscriptions.

## Exact bounded source scope

This is a targeted source pass, not full-file/full-archive review. Full or substantial reads were made of these frozen postimages:

- `apps/api/src/routes/workflowHierarchy.ts`
- `apps/api/src/modules/workflow-hierarchy/service.ts` (change cursor/read-query sections)
- `apps/api/src/modules/graph-drafts/currentStagedAgents.ts`
- `apps/api/src/modules/graph-drafts/currentEditIntent.ts` (normalization call location only; exact included filename is recorded in the inventory)
- `apps/api/test/workflow-hierarchy-stream.integration.test.ts`
- `apps/api/test/workflow-hierarchy-http-mcp.integration.test.ts` (test inventory/relevant default and removal locations only)
- `apps/web/src/features/workflow-hierarchy/{MasterOverview,HierarchyReportHistory,WorkerParentField,RemoveHierarchyNodeDialog,HierarchyEditor}.tsx`
- `apps/web/src/features/workflow-hierarchy/{queries,stream,authoring}.ts` (authoring targeted locations only)
- `apps/web/src/features/workflow-hierarchy/{MasterOverview,HierarchyEditor}.test.tsx` (fixtures/test inventory and targeted cases)
- `apps/web/src/features/workflow-hierarchy/execution-chat/WorkflowExecutionChatAdapter.tsx`
- `apps/web/src/features/graph/nextDraft/{useDraftEditorSave,useDraftAgentPanels,AuthoringFields}.ts[x]` (AuthoringFields targeted locations only)
- `apps/web/src/features/graph/AgentSettingsForm.tsx` (Apply/Cancel integration locations)
- `apps/web/src/features/workflow-board/{WorkflowBoard,WorkflowAgentPanel,AgentControls}.tsx`
- `apps/web/src/features/workflow-board/useWorkflowSidePanel.ts`
- `apps/web/src/features/workflow-board/hierarchyConflictRecovery.test.tsx`
- `apps/web/src/features/workflow-board/{WorkflowSidePanel,WorkflowBoard.runSelection}.test.tsx` (targeted rail pin case and test inventory)
- `apps/web/src/features/run-board/{RunBoard,RunBoardCanvas}.tsx`
- `apps/web/src/features/run-board/RunBoard.test.tsx` (test inventory only)
- `apps/web/src/features/run-subagents/{RunSubagentsOverlay,SubagentPanel}.tsx` and `query.ts`
- `apps/web/src/features/settings/BrowserProfilesSettings.tsx`
- `apps/web/src/routes/{SettingsExperienceRoutes,WorkspaceSectionRoutes}.tsx`
- `apps/web/src/routes/WorkspaceSectionRoutes.test.tsx` (new Memory/profile cases)
- Shared shell/router/navigation/ComputerCards registration locations and the included path inventory were inspected selectively. Those locations were not a complete shared-contract or all-consumer audit.

## Fresh-team continuation, in priority order

1. Author real authenticated direction-release/first-receipt/replay SSE regression using the actual execution-chat service and B/native owner port, with unchanged report revision.
2. Complete the one real recovery journey combining hierarchy/graph, staged Agents and raw forms through refresh, repeated conflict, manual reapply and fresh Save.
3. Finish actual canonical WorkflowBoard/RunBoard hierarchy, saved pins/layout, one rail, Show/Hide Workers, and retained hidden native-subagent composer/command/read regressions.
4. Add real supplied F3 factory/client regressions; the current fake-slot URL test is only shell evidence.
5. Refresh the final source audit and independent integrated review across all included D changes, fixing material findings through their owners. The quick Part 1 review does not clear prior backend/native/control findings or unreviewed paths.
6. Integrate real A/B/C exports at the agreed phase and perform user-run validation on the exact final source. Keep cutover OFF until its actual prerequisites are met. No local test/build/lint/native result is supplied in this archive.

This note is sufficient to identify the checkpoint honestly. It does not block packaging the user's explicitly requested current partial work.
