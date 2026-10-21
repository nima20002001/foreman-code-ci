# NIM-2576 handoff: `graphql` shell

> Historical Phase 1 record. Its browser-mock setup and walkthrough no longer
> apply: the browser now uses the real API, while MSW remains only in unit tests.

Status: Phase 1 implementation and verification complete.

## Scope and naming

The project is named `graphql`. It is a React/Vite shell for an agent
workspace, not an implementation of the GraphQL protocol or a GraphQL server.
The landing-page title and heading use `graphql`; the copy explicitly states
that the name does not imply GraphQL protocol tooling.

The repository currently contains only:

- `apps/web`: React, TanStack Router, TanStack Query, Zustand, React Flow, and
  the MSW-backed wireframe UI;
- `packages/contracts`: Zod schemas and inferred TypeScript types shared by the
  UI and a future API boundary.

There is no backend, GraphQL transport, execution engine, persistence layer,
real runner or harness, authentication/session system, browser automation,
terminal transport, external integration, or security enforcement in this
milestone. Disabled actions are context-only and do not start work.

## Runtime and commands

The root `package.json` declares Node `>=22.0.0`, pnpm `>=9.15.4`, and the
pinned `packageManager` value `pnpm@9.15.4`. Use that runtime from the
repository root:

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

The root scripts delegate to the two workspace packages where scripts exist.
`pnpm dev` runs `@graphql/web`'s Vite server. The web package scripts are:

```sh
pnpm --filter @graphql/web dev
pnpm --filter @graphql/web typecheck
pnpm --filter @graphql/web lint
pnpm --filter @graphql/web test
pnpm --filter @graphql/web build
pnpm --filter @graphql/web test:e2e
```

### Development MSW

MSW starts by default in the browser during development and is not a production
fallback. The checked-in browser bootstrap and
`apps/web/public/mockServiceWorker.js` run when `import.meta.env.DEV` is true
and `VITE_ENABLE_MSW` is not `'false'`. Run:

```sh
pnpm dev
```

Set `VITE_ENABLE_MSW=false` to run the shell against a real API instead:

```sh
VITE_ENABLE_MSW=false pnpm dev
```

Production builds never start MSW: without it, the browser must reach a real API
at the same client boundary. Vitest uses the Node MSW server from
`apps/web/src/test/setup.ts` automatically; it does not require the browser
worker or the environment flag. With MSW disabled and no backend, the landing
route still renders, but the Website workspace request is expected to show its
unavailable/error state.

## Routes and visible shell

| Route | Ownership and current behavior |
| --- | --- |
| `/` | `App` renders the `graphql` wireframe status card and a link to `/workspaces/workspace-1`. |
| `/workspaces/$workspaceId` | `WorkspaceRouteEntry` loads workspace details, renders the shell, and reads `agentId` from URL search state. `workspace-1` is the Website fixture. |

The workspace shell has a sidebar, workspace/runner header, central graph,
right context panel, and bottom terminal surface. Workspaces is the only
available navigation item. Agents, Browsers, Tasks, and Runs are visibly
disabled with “Unavailable”; they are not routes or working controls.

The shell defaults to dark mode. The workspace header has an accessible theme
button whose label names the destination theme. Choosing light or dark writes
`graphql-theme` to local storage and restores it before React mounts on later
loads; clearing the preference returns to dark. Theme is local interaction
state and is neither Query-owned nor encoded in the URL.

The shared URL schema accepts `scenarioId`, `workspaceId`, `agentId`,
`workflowId`, and `conversationId`. The current workspace route uses the path
`workspaceId` and the search `agentId`; the other search fields are contract
capacity, not implemented navigation in this shell. Selecting a graph node
writes `?agentId=<agent-id>` through TanStack Router. With no `agentId`, the
right panel resolves the stable Operator agent (`agent-operator`). “Return to
Operator” removes only `agentId`. An unknown selected ID produces a stale
selection state and does not leak unrelated conversation history.

## Owner walkthrough

This is the repeatable owner walkthrough for the Website workspace. It assumes
the development MSW worker was generated and the browser mocks are enabled (the
development default).

1. Open `http://127.0.0.1:5173/`, then open **Website** at
   `/workspaces/workspace-1`. Confirm the header says `Website`, the runner is
   `Local Runner` with health `Healthy`, and the graph is **Research to
   review** with Researcher → Developer → Reviewer nodes. The right panel
   defaults to **Operator**, shows its identity, current condition, history,
   composer, and disabled Phase 1 actions (`Run`, `Resume`, `Login`, `Open
   Browser`, `Files`).
2. Select the **Researcher** node. Confirm the URL contains
   `agentId=agent-researcher`, the context panel is Researcher, and its
   conversation is `Researcher brief`. Send a short message only if the
   mutation walkthrough is needed; the mock app appends a user message and
   does not fabricate an assistant reply. Return to Operator and confirm the
   search parameter is removed.
3. Select **Operator** by returning to the no-selection state. The default
   conversation is `Operator hand-off`; this is the stable coordination
   context, not a second copy of whichever agent is selected.
4. Exercise every scenario in the Mock data selector. The expected fixture
   changes are listed below. After each selection, allow the workspace query
   to refresh before inspecting the graph/context. Scenario selection resets
   fixture mutations but deliberately leaves local graph and conversation
   drafts alone.
5. In a non-empty scenario, drag a graph node or connect two distinct handles.
   Confirm the status changes to **Unsaved changes**. `Discard` removes the
   workflow-keyed local draft and returns to the saved query projection. `Save
   graph` sends the graph mutation; on success it updates the workflow and
   workspace query caches and clears the draft. The editor does not add or
   delete nodes, and the React Flow delete key is disabled.
6. To exercise the graph-save failure path, use the development console while
   MSW is running:

   ```js
   fetch('/api/mock/failures', {
     method: 'POST',
     headers: {'Content-Type': 'application/json'},
     body: JSON.stringify({failureMode: 'graph-save'})
   })
   ```

   Make another graph edit and save. The UI should show an alert beginning
   `Graph could not be saved`, and the dirty local draft must remain. Reset the
   mode with the same request and `{failureMode: 'none'}`. The selector itself
   does not expose failure modes; selecting a scenario posts the default
   `none` mode.
7. Expand **Terminal**. Confirm the panel says **No terminal connected** and
   the expanded copy explains that a runner must be connected; there is no
   prompt and no input. Collapse it again. Terminal expansion is local React
   interaction state, not a terminal connection.
8. Confirm the first visit is dark, activate **Switch to light theme**, reload,
   and confirm light persists. The control should then read **Switch to dark
   theme**. Clear the `graphql-theme` local-storage item to restore the dark
   default.

### Scenario matrix

| Scenario ID | Expected fixture/state signal |
| --- | --- |
| `normal` | Completed/succeeded `run-1`; all four agents are available; both browser profiles and the workflow are present. |
| `working` | Researcher is `working`; the run is `running` with `pending` outcome and no finish time. |
| `waiting-browser` | Researcher is `waiting_browser`; the run is `waiting`; GitHub is `in_use` and held by Operator; browser wait reason is `browser_profile`. |
| `auth-required` | Operator is `auth_required`; the run is `waiting` with `authRequired: true`; Website Admin is `auth_required` and held by Operator. |
| `interrupted` | Developer is `interrupted`; the run is `interrupted` with `pending` outcome and no finish time. |
| `runner-disconnected` | Developer is `disconnected`; the run is `running`; Local Runner health is `disconnected` with a message. |
| `empty` | No workflows, runs, resources, browser profiles, conversations, or messages; the workspace has no workflow IDs. The agent list remains from the base fixture. |
| `error` | Workspace reads return HTTP 503 `MOCK_READ_FAILED`; the route shows the unavailable/error state and offers retry where the workspace request failed. |

The mock API also accepts failure modes `none`, `graph-save`,
`user-message`, and `all`. `graph-save` makes graph PUTs return HTTP 503
`MOCK_GRAPH_SAVE_FAILED`; `user-message` makes user-message POSTs return HTTP
503 `MOCK_USER_MESSAGE_FAILED`; `all` does both. A failed message mutation
does not clear its conversation draft because drafts are cleared only after a
successful response.

### Reset, reload, and mutation semantics

- `POST /api/mock/scenario` selects a scenario, rebuilds its fixture, resets
  the message sequence, and (through the route control) follows with
  `POST /api/mock/reset`. The route updates the scenario query, removes
  inactive workspace projections, and invalidates active workspace queries.
- `POST /api/mock/reset` rebuilds the current scenario fixture and resets the
  message sequence without changing the selected scenario or failure mode.
- Scenario changes do not clear Zustand graph drafts or conversation drafts.
  This is intentional: server/query state is refreshed while local unsaved
  interaction state stays local.
- A full browser reload reinitializes the module-level fixture to
  `normal`/`none`; there is no persistence. Any local drafts also disappear
  because there is no persistence layer.
- A successful graph save updates the saved workflow projection and clears the
  draft unless newer local edits were made during the request. A failed save
  leaves the draft dirty. A successful user-message mutation appends only the
  returned user message to the conversation/messages caches and clears that
  conversation's draft.

## HTTP and contract inventory

All product HTTP calls go through `apps/web/src/shared/api/client.ts`. The
client validates request and response payloads with the shared contracts before
data reaches feature code. MSW mirrors the same paths during this wireframe
phase.

### Product endpoints

| Method and path | Client method | Contract response |
| --- | --- | --- |
| `GET /api/workspaces/:workspaceId` | `getWorkspaceDetails` / `getWorkspace` | `WorkspaceDetailsResponse` (`workspace`, `agents`, `workflows`, `runs`, `resources`, optional `browserProfiles`, `runners`) |
| `GET /api/workspaces/:workspaceId/agents` | `listAgents` | `{ agents: Agent[] }` |
| `GET /api/workspaces/:workspaceId/agents/:agentId` | `getAgent` | `{ agent: Agent }` |
| `GET /api/workspaces/:workspaceId/workflows/:workflowId` | `getWorkflow` | `{ workflow: WorkflowDefinition }` |
| `PUT /api/workspaces/:workspaceId/workflows/:workflowId` | `saveWorkflow` | `{ workflow: WorkflowDefinition }` |
| `PUT /api/workspaces/:workspaceId/graph` | `saveGraph` | `{ workflow: WorkflowDefinition }` |
| `GET /api/workspaces/:workspaceId/conversations` | `listConversations` | `{ conversations: Conversation[] }` |
| `GET /api/workspaces/:workspaceId/conversations/:conversationId` | `getConversation` | `{ conversation: Conversation, messages: Message[] }` |
| `GET /api/workspaces/:workspaceId/conversations/:conversationId/messages` | `listMessages` | `{ messages: Message[] }` |
| `POST /api/workspaces/:workspaceId/conversations/:conversationId/messages` | `createMessage` / `sendUserMessage` | `201 { message: Message }`; the UI sends `role: "user"` only |
| `GET /api/workspaces/:workspaceId/resources` | `listVisibleResources` | `{ resources: ResourceSummary[], browserProfiles?, runners? }` |

The mock-only control endpoints are `GET /api/mock/scenario`,
`POST` or `PUT /api/mock/scenario`, `POST /api/mock/reset`, and
`POST /api/mock/failures`. They are development harness controls, not a
backend API contract.

### Domain schemas

The public contract surface in `packages/contracts/src/index.ts` includes:

- identity and workspace: `Id`, `Timestamp`, `Workspace`, `Agent`,
  `HarnessSummary`; `Agent.activeRunId` links the current display projection to
  explicit run facts without putting wait data in harness metadata;
- graph and execution: `WorkflowDefinition`, `WorkflowNode`, `WorkflowEdge`,
  `ExecutionCondition`, `WorkflowRunSummary`/`RunSummary`,
  `BrowserWait`, `RunnerHealth`;
- conversation: `Conversation`, `Message` and their request/response
  schemas;
- resources: `ResourceSummary`/`VisibleResource`, `BrowserProfileSummary`,
  `RunnerSummary`;
- errors and endpoint payloads: `ApiError`, `ApiErrorResponse`, workspace,
  agent, workflow, conversation, message, and visible-resource request and
  response schemas;
- URL selection: `ScenarioId`, `UrlSearchSelection`/`ScenarioSelection`.

The endpoint-level schema names are `WorkspaceDetailsRequestSchema`,
`WorkspaceDetailsResponseSchema`, `ListAgentsRequestSchema`,
`ListAgentsResponseSchema`, `GetAgentRequestSchema`, `GetAgentResponseSchema`,
`GetWorkflowRequestSchema`, `GetWorkflowResponseSchema`,
`SaveWorkflowRequestSchema`, `SaveWorkflowResponseSchema`,
`ListConversationsRequestSchema`, `ListConversationsResponseSchema`,
`GetConversationRequestSchema`, `GetConversationResponseSchema`,
`ListMessagesRequestSchema`, `ListMessagesResponseSchema`,
`CreateMessageRequestSchema`, `CreateMessageResponseSchema`,
`ListVisibleResourcesRequestSchema`, and `ListVisibleResourcesResponseSchema`.
The read/save workflow and conversation/message/resource response aliases remain
contract aliases, not separate transport implementations.

Important identity rules: workflow nodes refer to an Agent through
`agentId`; conversations are scoped by their required `agentId`; and run
execution state, outcome, browser wait, auth requirement, and runner health
remain separate fields. A graph edge is not an authorization or execution
relationship.

### TanStack Query keys

The canonical key factory is `apps/web/src/shared/api/query.ts`:

| Factory | Key |
| --- | --- |
| `all` | `['workbench']` |
| `workspace(workspaceId)` | `['workbench', 'workspace', workspaceId]` |
| `workspaceDetails(workspaceId)` | `['workbench', 'workspace', workspaceId, 'details']` |
| `agents(workspaceId)` | `['workbench', 'workspace', workspaceId, 'agents']` |
| `agent(workspaceId, agentId)` | `['workbench', 'workspace', workspaceId, 'agent', agentId]` |
| `workflow(workspaceId, workflowId)` | `['workbench', 'workspace', workspaceId, 'workflow', workflowId]` |
| `conversations(workspaceId)` | `['workbench', 'workspace', workspaceId, 'conversations']` |
| `conversation(workspaceId, conversationId)` | `['workbench', 'workspace', workspaceId, 'conversation', conversationId]` |
| `messages(workspaceId, conversationId)` | `['workbench', 'workspace', workspaceId, 'conversation', conversationId, 'messages']` |
| `resources(workspaceId)` | `['workbench', 'workspace', workspaceId, 'resources']` |

The scenario selector uses a separate `['workbench', 'mock-scenario']` key.
The key prefix is an implementation namespace; it does not rename the
project or imply a GraphQL transport.

## State ownership

- TanStack Query owns server state and request lifecycle state. Workspace route
  data is the source for workspace/agent/workflow projections; save and message
  mutations update the relevant query caches after success.
- Zustand owns local interaction state only. Graph drafts are keyed by
  `workflowDraftKey(workspaceId, workflowId)`, formatted as
  `<workspaceId>::<workflowId>`, and carry `{ workflow, dirty: true }` until
  discard or successful save. Conversation drafts are keyed by
  `conversationId`, so changing agents cannot move text between threads. Theme
  preference is also local-only and persisted under `graphql-theme`.
- TanStack Router owns linkable navigation state. `workspaceId` is the path
  parameter and `agentId` is the selected-agent search parameter. The route
  does not copy URL selection into a second local store.
- The client boundary is the only HTTP access path. Feature code calls query
  hooks or client methods rather than importing fixture state.

## UX decision log

These are current decisions and unresolved placement questions.

| Topic | Current decision / unresolved point |
| --- | --- |
| Reusable-agent placement | The graph embeds workflow nodes that reference reusable Agent IDs. The sidebar Agents item is disabled, and there is no agent library route. Product placement of reusable agents remains unresolved. |
| Operator and context behavior | No selected node means the stable Operator context. Selecting a node changes only URL `agentId`; “Return to Operator” removes it. Stale IDs show a safe stale state and no unrelated history. |
| Terminal ownership | `WorkspaceShell` owns the bottom terminal slot and currently renders `TerminalPlaceholder`. It is an explicit no-connection state; ownership of a future terminal transport and runner session remains unresolved. |
| Edge meaning | The visible label is “Proposed sequential output handoff.” Edges are renderer/domain graph data only; they do not grant permission, reserve a resource, trigger work, or prove execution order. |
| Tasks and resources placement | Tasks/Browsers/Runs are disabled navigation. Resource summaries and browser profiles are contract/API data, but the current shell does not render a resource inventory. Their durable placement and interaction model remain unresolved. |

## Backend handoff boundary

Replace the MSW handlers behind the existing `ApiClient` methods; do not add a
second client or import server code into `apps/web`. A backend handoff must:

1. keep the product paths, methods, request bodies, and contract-shaped success
   and `ApiErrorResponse` error payloads listed above, or coordinate a contract
   version change in `packages/contracts`;
2. persist and authorize workspaces, Agent identities, workflow definitions,
   conversation ownership, messages, run projections, resources, browser
   profiles, and runner summaries on the server;
3. treat `executionState`, `outcome`, browser wait, `authRequired`, and runner
   health as separate server facts rather than inferring one from another;
4. preserve server-side permission, resource reservation, authentication,
   browser, runner, terminal, and execution enforcement. The UI's disabled
   buttons and graph edges are not security controls;
5. return the saved workflow/message in the mutation response so the existing
   query-cache update path remains valid; and
6. remove the development-only `/api/mock/*` controls from deployed traffic.

The wireframe intentionally sends only a user message and does not fabricate
an assistant response. A real conversation/execution system may add those
behaviors only through an explicit backend contract and server authority.

## Known limitations and non-goals

- There is no real execution, task start/resume/cancel, run polling, auth flow,
  browser control, runner connection, terminal input, or external integration.
- There is no persistence. Mock fixture mutations are in-memory and reload
  back to `normal`/`none`; local drafts disappear on reload.
- Browser MSW uses the checked-in worker asset and runs by default in
  development (`VITE_ENABLE_MSW=false` disables it); production never silently
  falls back to mocks.
- The graph currently supports moving nodes and connecting distinct existing
  nodes. Node creation/deletion and execution are intentionally absent.
- The visible resources endpoint and query hook exist for the boundary, but a
  resource inventory is not mounted in the shell.
- The mock scenario selector is a development harness. Its `error` scenario
  simulates read failure; it is not a production health or security model.
## Verification record

Final local verification was completed on 2026-09-13.

| Check | Current result | Evidence / caveat |
| --- | --- | --- |
| Static repository inspection | Pass | Package boundaries, route tree, API client, contracts, mocks, state stores, tests, and shell components were audited. |
| `pnpm install --frozen-lockfile` | Pass | The committed lockfile installs with the pinned workspace configuration. |
| `pnpm typecheck` | Pass | Both workspace typecheck scripts completed successfully. |
| `pnpm lint` | Pass | `apps/web` ESLint completed with `--max-warnings 0`. |
| `pnpm test` | Pass: 46 tests | Contracts: 5 tests; web: 41 tests. |
| `pnpm build` | Pass, warning | Vite production build completed. It emitted the existing chunk-size warning for the ~634 kB JS chunk. |
| `pnpm test:e2e` | Pass: 7 tests | Fresh-server Playwright covers HTTP/MSW loading, URL history, draft isolation, named wait facts, empty/error/stale states, terminal behavior, keyboard focus, labels, dark default, light switching, and persisted theme choice. |
| Live browser walkthrough | Pass | Content rendered, no Vite error overlay and no console errors. React Flow emitted only its attribution warning. Equivalent CUA browser checks were used because the `agent-browser` CLI was unavailable. Screenshot: `/tmp/graphql-workbench-final.png` (not committed). |

The browser screenshot and runtime/test artifacts are not committed.
