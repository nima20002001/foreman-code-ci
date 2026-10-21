import { describe, expect, it } from "vitest";

import { HarnessExecutionSchema } from "../src/index.js";
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema, type WorkflowVersionV3 } from "../src/wave25/saved.js";
import { makeCurrentWorkflowFixture } from "../src/wave25/currentFixture.js";

const timestamp = "2026-09-14T12:00:00.000Z";
const version: WorkflowVersionV3 = {
  id: "version-1",
  workspaceId: "workspace-1",
  workflowId: "workflow-1",
  version: 1,
  executionSemanticsVersion: 3, approval: { handler: "user" },
  entryNodeId: "node-1",
  definition: {
    id: "workflow-1",
    workspaceId: "workspace-1",
    name: "Review",
    version: 1,
    executionSemanticsVersion: 3, entryNodeId: "node-1", approval: { handler: "user" },
    executionCondition: { kind: "manual" },
    executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
    nodes: [
      { id: "node-1", agentId: "agent-1", name: "Research" },
      { id: "node-2", agentId: "agent-2", name: "Review" },
    ],
    edges: [{
      id: "edge-1", source: "node-1", target: "node-2",
      kind: "execution",
    }],
  },
  agentConfigurationVersionIds: { "agent-1": "config-1", "agent-2": "config-2" },
  contentHash: `sha256:${"0".repeat(64)}`,
  createdAt: timestamp,
};

describe("executable workflow graph integrity", () => {
  it("accepts a valid pinned graph", () => {
    expect(WorkflowVersionV3Schema.safeParse(version).success).toBe(true);
  });

  it.each(["source", "target"] as const)("rejects a missing %s", (endpoint) => {
    const candidate = structuredClone(version);
    candidate.definition.edges[0]![endpoint] = "missing-node";
    const result = WorkflowVersionV3Schema.safeParse(candidate);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["definition"], message: "relationships require distinct existing endpoints" }),
    ]));
    // Drafts remain editable; only executable snapshots enforce graph integrity.
    expect(WorkflowDefinitionV3Schema.safeParse(candidate.definition).success).toBe(true);
  });

  it("rejects duplicate node IDs", () => {
    const candidate = structuredClone(version);
    candidate.definition.nodes.push({ ...candidate.definition.nodes[0]! });
    const result = WorkflowVersionV3Schema.safeParse(candidate);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["definition"], message: "node and relationship IDs must be unique" }),
    ]));
  });

  it("rejects duplicate edge IDs", () => {
    const candidate = structuredClone(version);
    candidate.definition.edges.push({ ...candidate.definition.edges[0]! });
    const result = WorkflowVersionV3Schema.safeParse(candidate);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["definition"], message: "node and relationship IDs must be unique" }),
    ]));
  });

  it("accepts repeated Agents with exact pins and rejects arbitrary execution back-edges", () => {
    const duplicateAgent = structuredClone(version);
    if(duplicateAgent.definition.nodes[1]!.kind==='job')throw new Error('Agent fixture expected')
    duplicateAgent.definition.nodes[1]!.agentId = "agent-1";
    delete duplicateAgent.agentConfigurationVersionIds["agent-2"];
    const duplicate = WorkflowVersionV3Schema.safeParse(duplicateAgent);
    expect(duplicate.success).toBe(true);
    const cyclic = structuredClone(version);
    cyclic.definition.edges.push({ id: "loop", source: "node-2", target: "node-1", kind: "execution" });
    expect(WorkflowVersionV3Schema.safeParse(cyclic).success).toBe(false);
  });

  it("preserves multiple Job nodes and repeated Agents with exact pins", () => {
    const mixed = structuredClone(version);
    mixed.definition.nodes.push(...["job-1", "job-2"].map((id) => ({
      kind: "job" as const, id, name: id, jobDefinitionId: "definition-1",
      jobDefinitionRevision: 1, jobDefinitionVersionId: "job-version-1",
    })));
    mixed.definition.requiredAgentCount = 2;
    expect(WorkflowVersionV3Schema.safeParse(mixed).success).toBe(true);
    const agent = mixed.definition.nodes[1]!;
    if (agent.kind === "job") throw new Error("Agent fixture expected");
    agent.agentId = "agent-1";
    mixed.definition.requiredAgentCount = 1;
    delete mixed.agentConfigurationVersionIds["agent-2"];
    const duplicate = WorkflowVersionV3Schema.safeParse(mixed);
    expect(duplicate.success).toBe(true);
  });

  it("represents finite business repetition through the optional explicit plan", () => {
    const repeated = makeCurrentWorkflowFixture("integrity-repeat", "repeat");
    expect(WorkflowVersionV3Schema.parse(repeated.version)).toEqual(repeated.version);
    expect(repeated.version.definition.repeat?.blocks[0]?.maxOccurrences).toBe(3);
    expect(version.definition).not.toHaveProperty("repeat");
  });
});

const attempt = {
  id: "attempt-1", runId: "run-1", workflowNodeId: "node-1",
  agentId: "agent-1", agentConfigurationVersionId: "config-1",
  attempt: 1, input: {}, createdAt: timestamp,
};
const terminalFields = [
  { result: { outcome: "succeeded" } },
  { finishedAt: timestamp },
  { result: { outcome: "succeeded" }, finishedAt: timestamp },
];

describe("harness attempt terminal invariants", () => {
  for (const state of ["queued", "starting", "running", "waiting"] as const) {
    it(`accepts unfinished ${state} attempts`, () => {
      expect(HarnessExecutionSchema.safeParse({ ...attempt, state }).success).toBe(true);
    });
    it.each(terminalFields)(`rejects terminal fields on ${state}: %j`, (fields) => {
      expect(HarnessExecutionSchema.safeParse({ ...attempt, state, ...fields }).success).toBe(false);
    });
  }

  it("requires both a result and finish time for completed attempts", () => {
    for (const fields of [{}, terminalFields[0], terminalFields[1]]) {
      expect(HarnessExecutionSchema.safeParse({ ...attempt, state: "completed", ...fields }).success)
        .toBe(false);
    }
    expect(HarnessExecutionSchema.safeParse({
      ...attempt, state: "completed", ...terminalFields[2],
    }).success).toBe(true);
  });
});
