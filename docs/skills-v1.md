# Skills v1 (NIM-2672)

Database-backed Skills: a Settings library, board Agent assignment, unified-MCP management,
immutable version pinning, and native instruction delivery for Codex and Claude.

## Model

- A **skill** is workspace-owned Markdown instruction text. `workspace_skills` holds one logical
  head per skill (current version, revision, version count, archive state). Content lives only in the
  existing immutable `workspace_skill_versions` rows.
- **Saving** a changed skill creates the next server-allocated version (`"1"`, `"2"`, …). An identical
  save creates nothing (`changed: false`). Updates require `expectedRevision`; a stale revision
  returns `SKILL_REVISION_CONFLICT` with `details.currentRevision`. Commands replay through the existing
  command receipts; a reused `commandId` with different input returns `COMMAND_ID_CONFLICT`.
- **Archive** hides a skill from lists and from new assignment. Versions and pinned snapshots are kept;
  an Agent that already pinned an archived version keeps it through unrelated edits.
- Instructions are stored and delivered literally: no trimming, templating, includes, URL fetches,
  packages or scripts. A single UTF-8 Markdown file can be imported into the editor, previewed, then saved.

## Assignment and pinning

- Board Agents keep an ordered `assignedSkills: [{ skillId, version }]`, one version per skill, from the
  Agent's workspace. The application-level Operator keeps
  `agentDefaults.operator.assignedSkills: [{ workspaceId, skillId, version }]` because it is not
  workspace-owned. Operator snapshot identity includes the workspace, so two workspaces may have the same skill ID.
- On configuration publication the server resolves exact versions and pins full snapshots
  (`resolvedSkills` with name, body, hash) plus `instructionDelivery: "native-v1"` into the immutable
  Agent/Operator configuration. Callers cannot supply `resolvedSkills` (strict schemas reject it).
- Runs and resumed sessions use only the accepted configuration. Newer skill versions are used only
  after an explicit update (board "Use version N", `agent_update`, or Operator defaults) and Save.
- Limits: 100 skills per Agent, 100,000 characters per skill, **512 KiB** (UTF-8) for persistent Agent
  instructions plus all pinned skills. Oversized bundles are rejected (`AGENT_INSTRUCTIONS_TOO_LARGE`),
  never truncated.

## Delivery

One composer (`apps/api/src/modules/skills/instructions.ts`) builds the bundle: the Agent's persistent
instructions (`prompt.system`), then each skill as `# Skill: <name> (<id>@<version>)` followed by its full
body, in saved order. Snapshot identity/order/hash are verified before any native side effect.

| Harness | Channel | Notes |
| --- | --- | --- |
| Codex app-server | `developerInstructions` on `thread/start` and `thread/resume` | `baseInstructions` untouched; task text is only the turn input. |
| Claude SDK | Accepted `instructions` and system prompt bundle | The saved Agent instructions and pinned skill bodies are passed to the owned SDK session. |

Configurations accepted before this change (no `instructionDelivery`) keep their original in-task
prompt sections, so existing sessions do not switch behavior.

## HTTP and MCP

| Operation | HTTP | MCP tool | Action |
| --- | --- | --- | --- |
| List logical skills (all readable workspaces, or one) | `GET /api/management/skills` | `skill_list` | `skills:read` |
| Read head + exact version | `GET /api/management/workspaces/:ws/skills/:id?version=` | `skill_get` | `skills:read` |
| Version history | `GET …/skills/:id/versions` | `skill_versions_list` | `skills:read` |
| Create | `POST /api/management/workspaces/:ws/skills` | `skill_create` | `skills:publish` |
| Save new version | `PATCH …/skills/:id` | `skill_update` | `skills:publish` |
| Archive / restore | `PUT …/skills/:id/archive` | `skill_archive` | `skills:publish` + `skills:read` |
| Read all consumers needing updates | `GET …/skills/:id/usage` | `skill_usage_get` | `skills:read` |
| Update consumers and workflow pins | `POST …/skills/:id/update-users` | `skill_users_update` | `skills:read` + `agents:update` + normal Agent/workflow save permissions |
| Assign to a board Agent | Agent create/update, board Save | `agent_create`, `agent_update`, `workflow_edit_v3`/`workflow_save_v3` staged Agents | `skills:read` (source) + Agent/graph edit (destination) |
| Assign to the Operator | `PUT /api/management/settings/agents` | `agent_defaults_update` | `settings:update` + `skills:read` on each referenced workspace |

`skill_publish` (caller-chosen version labels) is replaced by `skill_create`/`skill_update`.
Consumer reads and updates cover the full workspace. Bulk updates retain the skill head, consumer set,
revisions and workflow pins before the first child save. Retry the same command ID to resume failed items
or replay the completed result; use a new ID to include newer skill versions or consumers. Unrelated
workflow pins stay unchanged; conflicting concurrent Agent edits are reported as item failures.
Skill tools are Operator-role tools on the one `/mcp` server. They stay listed for every Operator
credential and the service checks grants and workspace scope on each call, so a forbidden call returns
an audited `ACCESS_DENIED` with no side effects. Orchestrator/Coder credentials are not offered them.
Republishing Operator settings (including harness or thinking-only changes) requires source `skills:read` for every assigned workspace.
Audit rows record `http` or `mcp` as the source; bodies are not logged.

## Migration

`267201` (`skillsLibraryMigration`) adds `workspace_skill_versions.sequence` (backfilled by
`created_at, version`), creates `workspace_skills`, and backfills one head per existing skill from its
latest version. Existing version rows are not rewritten. New versions skip any historical label that is
already taken.

## Decisions and deviations

- Markdown preview shows the literal text (React-escaped, monospace). No renderer was added, per the
  "no new markdown engine" rule; nothing is executed or fetched.
- Operator skills are chosen in Settings → Agents → Operator and may come from any workspace the user
  can read; the Operator stays non-board-addable.
- Worker-role (Orchestrator/Coder) callers do not see skill tools. Under the merged unified MCP (#46)
  a direct call to an unlisted tool is refused by the SDK as an unknown tool rather than with a
  role-specific permission error.

## Verification

- `apps/api/test/skills-library.integration.test.ts` (PostgreSQL): backfill, versions, replay, stale
  revision, concurrency, archive, HTTP/MCP parity with audit source, scoped/read-only/revoked/Worker
  denials without mutation, pinning, forged/foreign/duplicate/missing/archived/oversized references,
  Operator skills across workspaces.
- `skills-instructions.test.ts`, `codex-app-server.test.ts` (SKL-05): bundle
  order, full bodies, task separation, legacy mode, corrupt/oversized failures before native calls,
  resume/attach retention, correlation conflicts.
- `apps/web/src/features/skills/skills.test.tsx`: library states, validation/focus, double submit,
  conflicts, lost response, remote edits vs dirty drafts, safe preview, import, board picker.
- `skills-native.acceptance.test.ts` (`RUN_SKILLS_NATIVE=1`): native Codex instruction delivery —
  skilled vs concurrent control sessions, later turn, backend restart, Operator sessions.
