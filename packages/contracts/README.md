# `@foreman-code/contracts`

The contracts package is the neutral boundary shared by the UI, API,
orchestrator, and harness adapters. It contains Zod schemas and inferred
TypeScript types for workspace details, agents, workflow definitions and
versions, conversations, messages, runs, harness execution, activity,
resources, API errors, endpoint payloads, and URL scenario selection.

The package deliberately keeps three concepts separate:

- a workflow node references an Agent through `agentId`; it is not an embedded Agent;
- a Conversation is scoped to its owning Agent through required `agentId` (including
  the Operator conversation);
- `executionState` and `outcome` describe different aspects of a run;
- browser wait reason, resource identity/name, holder identity/label, and optional
  execution identity are explicit fields rather than only a holder-kind enum;
- `authRequired` and runner health are explicit fields rather than overloaded outcome/status values.
- every durable run pins one immutable workflow version and the agent
  configuration versions used by its nodes;
- routing uses explicit outcomes and optional result predicates, while join,
  repeat, and parallelism bounds remain first-class facts;
- native harness sessions receive their prompt, assigned skill versions,
  working directory, and harness-specific configuration through a pinned
  `HarnessExecutionRequest`; Codex reasoning/sandbox/service-tier fields are
  not reused as OpenCode variant/native-Agent fields.

Agent projections can independently expose `executionState` (and the matching
`status` vocabulary) as `available`, `working`, `waiting_browser`,
`auth_required`, `interrupted`, or `disconnected`. They may also include a
`role` and `harnessSummary` for the context panel. `activeRunId` is the
neutral link from that logical Agent projection to its current `RunSummary`;
browser wait, resource, and runner facts stay on the run projection and are
not encoded in harness metadata.

Import the public surface from `@foreman-code/contracts`. No React, persistence,
transport, LangGraph implementation, or native runner implementation belongs
here.
