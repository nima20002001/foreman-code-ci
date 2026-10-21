# ADR: Workspace-owned execution locations

- Status: Accepted
- Date: 2026-09-15
- Scope: NIM-2588 through NIM-2593

## Decision

An executable workspace owns one runner-side location: `{ runnerId, rootPath }`, with an independent optimistic-concurrency revision. Workflows and Agents inherit it. This release supports only the stable `runner-local` identity and stores the canonical destination of an existing directory.

The local runner validates path syntax, type, traversal/read access, and write access when the pinned harness configuration needs it. Validation uses filesystem APIs and has no creation, permission, hook, dependency-install, shell, or harness side effects. Project and Foreman Code runtime roots cannot overlap.

Run admission atomically pins the current saved workflow version and the accepted location identity/revision with the command receipt. Every node uses that immutable location. Mutable Settings are not reread to choose later-node directories. Availability, detectable directory identity, and the accepting Operator authority are rechecked; failures never trigger a fallback directory.

The harness request separates `workingDirectory` (the user project) from `runtimeDirectory` (Foreman Code-owned per-attempt storage below `HARNESS_WORKSPACE_ROOT`). Native sessions and runtime directories remain distinct even when Agents intentionally share project files.

## Authorization and interfaces

Workspace Settings, management HTTP, and Operator MCP call the same `WorkspaceLocationService`. The service owns runner validation and location revision checks. `workspace_update` stays metadata-only.

Host paths require explicit `workspace_locations:read`, `workspace_locations:validate`, or `workspace_locations:update` grants. Authentication and resource authorization occur before filesystem probing, so unauthorized callers do not learn whether a path exists. Worker-audience credentials remain invalid for Operator MCP.

## Migration and consequences

Legacy workspaces migrate to location revision zero with no location. They remain editable, but new run admission fails with an actionable setup error. Legacy run history remains parseable without a fabricated location, and a queued legacy run without a snapshot cannot be silently launched in a newly configured directory.

Location is not confinement. Native Codex/Claude policies, environment and network controls, remote runners, managed worktrees, locking, and OS/container isolation remain deferred. Existing sandbox and authorization protections are not weakened.
