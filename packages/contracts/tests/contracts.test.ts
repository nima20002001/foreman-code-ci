import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  AgentConfigurationVersionSchema,
  AgentStatusSchema,
  ApiErrorResponseSchema,
  BrowserWaitSchema,
  ConversationSchema,
  ExecutionConditionSchema,
  HarnessSummarySchema,
  HarnessExecutionRequestSchema,
  MessageSchema,
  ResourceSummarySchema,
  RunSummarySchema,
  SaveWorkflowRequestSchema,
  ScenarioSelectionSchema,
  WorkflowRunSchema,
  WorkspaceDetailsResponseSchema,
  AgentDefaultsSchema,
  CODEX_APPROVAL_OPTIONS_FIXTURE,
  CreateConversationRequestSchema,
  DurableInteractionSchema,
  NATIVE_INTERACTION_FIXTURES,
  WorkflowApprovalConfigurationSchema,
  AcceptedWorkflowApprovalConfigurationSchema,
  CodexHarnessConfigurationSchema,
  CodexSessionCompatibilitySchema,
  DEFAULT_AGENT_DEFAULTS,
  validateHarnessWorkflowCompatibility,
  ScopedMcpDetectionSchema,
} from "../src/index.js";

import {
  AgentDefaultsUpdateInputSchema, WorkflowDefaultsUpdateInputSchema,
  ManagedAgentDefaultsSchema, ManagedWorkflowDefaultsSchema,
} from "../src/management/index.js";

import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema } from "../src/wave25/saved.js";
import { makeCurrentWorkflowFixture } from "../src/wave25/currentFixture.js";

const condition = { kind: "manual" as const };
const agent = { id: "agent-1", name: "Researcher" };
const workflow = {
  id: "workflow-1",
  workspaceId: "workspace-1",
  name: "Research workflow",
  executionSemanticsVersion: 3 as const,
  entryNodeId: "node-1",
  approval: { handler: "user" as const },
  executionCondition: condition,
  nodes: [{ id: "node-1", agentId: "agent-1", name: "Research" }],
  edges: [],
};

describe("neutral product contracts", () => {
  it("round-trips runner-scoped MCP detection without accepting extra authority fields", () => {
    const scoped = {
      detection: {
        harness: "codex" as const, serverName: "graphql-app", state: "connected" as const,
        endpointMatches: true, credentialEnvironmentVariable: "GRAPHQL_APP_MCP_TOKEN",
        checkedAt: "2026-09-16T00:00:00.000Z",
      },
      runnerId: "runner-local", workingDirectory: "/srv/graphql/workspace", providerVersion: "0.154.0",
      nativeFilters: { enabledTools: ["context_get"], disabledTools: ["interaction_respond"], diagnostics: [] },
    };
    expect(ScopedMcpDetectionSchema.parse(scoped)).toEqual(scoped);
    expect(ScopedMcpDetectionSchema.safeParse({ ...scoped, workspaceId: "forged" }).success).toBe(false);
    expect(ScopedMcpDetectionSchema.safeParse({ ...scoped, workingDirectory: "bad\0path" }).success).toBe(false);
  });

  it("defines server-owned roles, approval assignment and truthful provider options", () => {
    expect(AgentDefaultsSchema.safeParse({
      orchestrator: { role: "orchestrator", boardAddable: true, harness: { harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard" } },
      coder: { role: "coder", boardAddable: true, harness: { harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard" } },
      operator: { role: "operator", boardAddable: false, uiEnabled: true, harness: { harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard" } },
    }).success).toBe(true);
    expect(WorkflowApprovalConfigurationSchema.safeParse({ handler: "orchestrator" }).success).toBe(true);
    expect(AcceptedWorkflowApprovalConfigurationSchema.safeParse({ handler: "orchestrator" }).success).toBe(false);
    for (const handler of ["user"] as const) {
      expect(WorkflowApprovalConfigurationSchema.safeParse({ handler, designatedOrchestratorAgentId: "agent-1" }).success).toBe(false);
      expect(AcceptedWorkflowApprovalConfigurationSchema.safeParse({ handler, designatedOrchestratorAgentId: "agent-1" }).success).toBe(false);
      expect(AcceptedWorkflowApprovalConfigurationSchema.safeParse({ handler }).success).toBe(true);
    }
    expect(WorkflowApprovalConfigurationSchema.safeParse({ handler: "operator" }).success).toBe(false);
    expect(CODEX_APPROVAL_OPTIONS_FIXTURE.some((option) => option.semantic === "allow_session")).toBe(true);
    expect(DurableInteractionSchema.parse(NATIVE_INTERACTION_FIXTURES.codex).nativeRequestId).toBe("codex-request-fixture");
  });

  it("keeps approval drafts editable but requires a complete accepted version and Run snapshot", () => {
    const incompleteApproval = { handler: "orchestrator" as const };
    const acceptedApproval = { ...incompleteApproval, designatedOrchestratorAgentId: "agent-1" };
    const executableDefinition = {
      ...workflow, approval: incompleteApproval, version: 1,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
    };
    const version = {
      id: "workflow-1-v1", workspaceId: "workspace-1", workflowId: "workflow-1", version: 1,
      executionSemanticsVersion: 3, entryNodeId: "node-1", definition: executableDefinition,
      agentConfigurationVersionIds: { "agent-1": "agent-config-1" },
      contentHash: `sha256:${"0".repeat(64)}`, createdAt: "2026-09-16T00:00:00.000Z",
    };
    expect(WorkflowDefinitionV3Schema.safeParse({ ...workflow, approval: incompleteApproval }).success).toBe(true);
    expect(WorkflowVersionV3Schema.safeParse({ ...version, approval: incompleteApproval }).success).toBe(false);
    expect(WorkflowVersionV3Schema.safeParse({ ...version, approval: acceptedApproval, definition: { ...executableDefinition, approval: acceptedApproval } }).success).toBe(true);

    const run = {
      id: "run-1", workspaceId: "workspace-1", workflowId: "workflow-1", workflowVersionId: version.id,
      executionSemanticsVersion: 3,
      agentConfigurationVersionIds: version.agentConfigurationVersionIds, executionCondition: condition,
      executionState: "queued", outcome: "pending", input: {}, createdAt: "2026-09-16T00:00:00.000Z",
    };
    expect(WorkflowRunSchema.safeParse({ ...run, approval: incompleteApproval }).success).toBe(false);
    expect(WorkflowRunSchema.safeParse({ ...run, approval: acceptedApproval }).success).toBe(true);
  });

  it("round-trips exact provider Advanced settings while preserving legacy omission", () => {
    const codex = CodexHarnessConfigurationSchema.parse({
      harness: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium", sandbox: "workspace-write", serviceTier: "standard",
      advanced: {
        approvalPolicy: "on-request", approvalsReviewer: "user", additionalWritableDirectories: ["/tmp/project"],
        workspaceWrite: { networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        sessionPersistence: "persistent", shellEnvironment: { inherit: "all", ignoreDefaultExcludes: false, filters: { "AWS_*": "exclude" }, set: {} },
        webSearch: "cached", mcpServers: { app: { enabled: true, required: true, enabledTools: ["context_get"], disabledTools: ["interaction_respond"], tools: { context_get: { enabled: true, approvalMode: "auto" } } } },
      },
    });
    expect(CodexHarnessConfigurationSchema.parse(codex)).toEqual(codex);
    expect(CodexHarnessConfigurationSchema.safeParse({ ...codex, advanced: { ...codex.advanced, mcpServers: { app: { enabled: false, required: true } } } }).success).toBe(false);
    expect(CodexHarnessConfigurationSchema.safeParse({ ...codex, sandbox: "read-only" }).success).toBe(false);

    expect(() => validateHarnessWorkflowCompatibility(codex, "user")).not.toThrow();
  });

  it("validates versioned Settings DTOs and ephemeral Codex limitations", () => {
    const agents = ManagedAgentDefaultsSchema.parse({
      value: DEFAULT_AGENT_DEFAULTS, versionId: "agent-defaults-v1", revision: 1,
    });
    const agentInput = { commandId: "update-agents", value: agents.value, expectedRevision: agents.revision };
    expect(AgentDefaultsUpdateInputSchema.parse(agentInput).value.operator.uiEnabled).toBe(true);
    const workflows = ManagedWorkflowDefaultsSchema.parse({
      value: { approvalHandler: "orchestrator" }, versionId: null, revision: 0,
    });
    const workflowInput = { commandId: "update-workflows", value: workflows.value, expectedRevision: 0 };
    expect(WorkflowDefaultsUpdateInputSchema.parse(workflowInput)).toEqual(workflowInput);
    const ephemeral = CodexHarnessConfigurationSchema.parse({
      harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard",
      advanced: { approvalPolicy: "on-request", approvalsReviewer: "user", additionalWritableDirectories: [], sessionPersistence: "ephemeral", shellEnvironment: { inherit: "all", ignoreDefaultExcludes: false, filters: {}, set: {} }, webSearch: "cached", mcpServers: {} },
    });
    expect(CodexSessionCompatibilitySchema.safeParse({ configuration: ephemeral, requiresResume: true, responseOptions: [] }).success).toBe(false);
    expect(CodexSessionCompatibilitySchema.safeParse({ configuration: ephemeral, requiresResume: false, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }).success).toBe(false);
  });

  it("supports application-global Operator conversations without a fake workspace", () => {
    expect(CreateConversationRequestSchema.safeParse({
      scope: "application", agentId: "application-operator", operatorConfigurationVersionId: "operator-config-v1",
    }).success).toBe(true);
    expect(ConversationSchema.safeParse({
      id: "conversation-global", scope: "application", workspaceId: "fake", agentId: "application-operator",
      operatorConfigurationVersionId: "operator-config-v1",
    }).success).toBe(false);
  });
  it("accepts the required workspace, agent, workflow and conversation scenario", () => {
    expect(
      WorkspaceDetailsResponseSchema.parse({
        workspace: { id: "workspace-1", name: "Demo" },
        agents: [agent],
        workflows: [workflow],
        runs: [],
        resources: [],
      }),
    ).toMatchObject({ workspace: { id: "workspace-1" } });

    expect(
      AgentSchema.parse({
        ...agent,
        role: "researcher",
        executionState: "available",
        activeRunId: "run-1",
        harnessSummary: { status: "ready", label: "Local harness", runnerId: "runner-1" },
      }),
    ).toMatchObject({ role: "researcher", executionState: "available", activeRunId: "run-1" });
    for (const executionState of [
      "available",
      "working",
      "waiting_browser",
      "auth_required",
      "interrupted",
      "disconnected",
    ] as const) {
      expect(AgentSchema.parse({ ...agent, executionState }).executionState).toBe(executionState);
    }
    expect(WorkflowDefinitionV3Schema.parse({
      ...workflow,
      nodes: [{
        ...workflow.nodes[0],
        width: 280,
        height: 140,
        initialPrompt: "Summarize the accepted input.",
      }],
    }).nodes[0]).toMatchObject({
      agentId: "agent-1",
      width: 280,
      height: 140,
      initialPrompt: "Summarize the accepted input.",
    });
    expect(WorkflowDefinitionV3Schema.safeParse({
      ...workflow,
      nodes: [{ ...workflow.nodes[0], width: 0 }],
    }).success).toBe(false);
    expect(
      ConversationSchema.parse({ id: "conversation-1", workspaceId: "workspace-1", agentId: "agent-operator" }),
    ).toEqual({ id: "conversation-1", workspaceId: "workspace-1", agentId: "agent-operator" });
    expect(ConversationSchema.safeParse({ id: "conversation-1", workspaceId: "workspace-1" }).success).toBe(false);
  });

  it("keeps workflow node identity separate from an Agent", () => {
    expect(
      WorkflowDefinitionV3Schema.safeParse({
        ...workflow,
        nodes: [{ id: "node-1", name: "Research", agent: agent }],
      }).success,
    ).toBe(false);
    expect(
      WorkflowDefinitionV3Schema.safeParse({
        ...workflow,
        nodes: [{ id: "node-1", name: "Research", agentId: "agent-1" }],
      }).success,
    ).toBe(true);
  });

  it("requires an explicit execution condition", () => {
    expect(ExecutionConditionSchema.safeParse({}).success).toBe(false);
    expect(WorkflowDefinitionV3Schema.safeParse({ ...workflow, executionCondition: undefined }).success).toBe(
      false,
    );
  });

  it("does not conflate interruption, outcome, browser waits or runner health", () => {
    const result = RunSummarySchema.safeParse({
      id: "run-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      executionCondition: condition,
      executionState: "interrupted",
      outcome: "pending",
      authRequired: true,
      browserWait: {
        reason: "auth_required",
        resourceHolder: "operator",
        resourceId: "browser-github",
        resourceName: "GitHub browser profile",
        holderId: "agent-operator",
        holderLabel: "Operator",
        executionId: "run-1",
        executionLabel: "Research run",
      },
      runnerHealth: { status: "degraded" },
    });
    expect(result.success).toBe(true);
    expect(
      RunSummarySchema.safeParse({
        id: "run-1",
        workspaceId: "workspace-1",
        workflowId: "workflow-1",
        executionCondition: condition,
        executionState: "interrupted",
        outcome: "interrupted",
        authRequired: true,
        browserWait: null,
        runnerHealth: { status: "healthy" },
      }).success,
    ).toBe(false);
    expect(BrowserWaitSchema.safeParse({ reason: "auth_required" }).success).toBe(false);
    expect(AgentStatusSchema.safeParse("idle").success).toBe(false);
    expect(HarnessSummarySchema.safeParse({ status: "ready", resourceId: "browser-github" }).success).toBe(false);
  });

  it("validates API errors and endpoint request/response shapes", () => {
    expect(
      ApiErrorResponseSchema.parse({ error: { code: "WORKSPACE_NOT_FOUND", message: "Not found" } }),
    ).toEqual({ error: { code: "WORKSPACE_NOT_FOUND", message: "Not found" } });
    expect(
      SaveWorkflowRequestSchema.safeParse({ workspaceId: "workspace-2", workflow }).success,
    ).toBe(false);
    expect(MessageSchema.safeParse({ id: "message-1", conversationId: "conversation-1", role: "user" }).success).toBe(
      false,
    );
    expect(
      ResourceSummarySchema.safeParse({
        id: "browser-1",
        kind: "browser",
        name: "Chrome",
        status: "available",
        resourceHolder: "none",
        authRequired: false,
      }).success,
    ).toBe(true);
    expect(ScenarioSelectionSchema.parse({ scenarioId: "workflow-editor", workflowId: "workflow-1" })).toEqual({
      scenarioId: "workflow-editor",
      workflowId: "workflow-1",
    });
  });

  it("pins immutable workflow and agent configuration versions", () => {
    const agentConfiguration = AgentConfigurationVersionSchema.parse({
      id: "agent-config-1-v3",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      version: 3,
      prompt: { system: "Research the requested subject." },
      assignedSkills: [{ skillId: "skill-web-research", version: "2.1.0" }],
      harness: {
        harness: "codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        sandbox: "read-only",
        serviceTier: "standard",
      },
      contentHash: "sha256:agent-config",
      createdAt: "2026-09-14T00:00:00.000Z",
    });

    const versionedWorkflow = {
      ...workflow,
      version: 4,
      executionPolicy: { maxParallelism: 3, maxNodeExecutions: 12 },
      nodes: [{ ...workflow.nodes[0], join: { mode: "all" as const } }],
      edges: [],
    };
    expect(
      WorkflowVersionV3Schema.parse({
        id: "workflow-1-v4",
        workspaceId: "workspace-1",
        workflowId: "workflow-1",
        version: 4,
        executionSemanticsVersion: 3, approval: workflow.approval,
        entryNodeId: "node-1",
        definition: versionedWorkflow,
        agentConfigurationVersionIds: { "agent-1": agentConfiguration.id },
        contentHash: `sha256:${"0".repeat(64)}`,
        createdAt: "2026-09-14T00:00:00.000Z",
      }).agentConfigurationVersionIds,
    ).toEqual({ "agent-1": "agent-config-1-v3" });

    expect(
      WorkflowVersionV3Schema.safeParse({
        id: "workflow-1-v4",
        workspaceId: "workspace-1",
        workflowId: "workflow-1",
        version: 4,
        executionSemanticsVersion: 3, approval: workflow.approval,
        entryNodeId: "node-1",
        definition: versionedWorkflow,
        agentConfigurationVersionIds: {},
        contentHash: `sha256:${"0".repeat(64)}`,
        createdAt: "2026-09-14T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("models explicit routing, bounded repeats, parallel attempts and native session input", () => {
    // Current positive fixtures are authored as V3, not converted legacy graphs.
    const conditional = makeCurrentWorkflowFixture("contract-routing", "conditional");
    const repeated = makeCurrentWorkflowFixture("contract-repeat", "repeat");
    expect(WorkflowVersionV3Schema.parse(conditional.version).definition.nodes[0]?.choice?.outcomes)
      .toEqual(conditional.version.definition.nodes[0]?.choice?.outcomes);
    expect(WorkflowVersionV3Schema.parse(repeated.version).definition.repeat?.blocks[0]?.maxOccurrences).toBe(3);
    expect(WorkflowDefinitionV3Schema.safeParse({
      ...conditional.version.definition,
      edges: [{ ...conditional.version.definition.edges[0], route: { outcomes: ["succeeded"], maxTraversals: 2 } }],
    }).success).toBe(false);
    expect(WorkflowDefinitionV3Schema.safeParse({
      ...conditional.version.definition,
      nodes: conditional.version.definition.nodes.map((node) => ({ ...node, join: { mode: "any" } })),
    }).success).toBe(false);

    const run = WorkflowRunSchema.parse({
      id: "run-2",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      workflowVersionId: "workflow-1-v2",
      executionSemanticsVersion: 3, approval: workflow.approval,
      executionLocation: {
        runnerId: "runner-local",
        rootPath: "/srv/project",
        locationRevision: 4,
        identityHash: `sha256:${"a".repeat(64)}`,
      },
      agentConfigurationVersionIds: {
        "agent-1": "agent-config-1-v3",
        "agent-2": "agent-config-2-v1",
      },
      executionCondition: condition,
      executionState: "running",
      outcome: "pending",
      input: { request: "Research this" },
      createdAt: "2026-09-14T00:00:00.000Z",
    });
    expect(run.workflowVersionId).toBe("workflow-1-v2");
    expect(
      WorkflowRunSchema.safeParse({
        ...run,
        executionState: "completed",
        outcome: "succeeded",
      }).success,
    ).toBe(false);

    expect(
      HarnessExecutionRequestSchema.parse({
        executionId: "execution-1",
        runId: run.id,
        workspaceId: run.workspaceId,
        workflowNodeId: "node-1",
        workingDirectory: "/tmp/graphql-run",
        runtimeDirectory: "/tmp/graphql-runtime/run-1/node-1/attempt-1",
        configuration: {
          id: "agent-config-1-v3",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          version: 3,
          prompt: { system: "Research the requested subject." },
          assignedSkills: [{ skillId: "skill-web-research", version: "2.1.0" }],
          harness: {
            harness: "codex",
            model: "gpt-5.6-luna",
            reasoningEffort: "high",
            sandbox: "read-only",
            serviceTier: "standard",
          },
          contentHash: "sha256:agent-config",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
        input: run.input,
      }).configuration.assignedSkills,
    ).toEqual([{ skillId: "skill-web-research", version: "2.1.0" }]);
  });
});
