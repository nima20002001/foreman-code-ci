import { describe, expect, it } from "vitest";
import { CurrentWorkflowRelationshipSchema } from "./wave25/workflowShape.js";
import {
  RunBoardNodeSnapshotSchema, RunBoardSnapshotGetInputSchema, RunBoardSnapshotGetResultSchema, RunBoardSnapshotSchema,
  RunDropdownListInputSchema, RunDropdownPageSchema, RunDropdownSummarySchema, RunDropdownStatusSchema,
  SelectedRunChatKeySchema, runDropdownStatus,
} from "./runSnapshots.js";

const scope = { workspaceId: "workspace-1", workflowId: "workflow-1", runId: "run-1" };
const summary = { runId: scope.runId, shortId: "run-1", startedAt: "2026-09-28T10:00:00.000Z",
  status: "running" as const, trigger: "schedule" as const };
const node = { id: "node-a", name: "Name at admission", agentId: "agent-1", agentConfigurationVersionId: "agent-version-7",
  position: { x: -25, y: 100.5 }, size: { width: 280, height: 160 } };
const edge = { id: "edge-1", source: "node-a", target: "node-b", kind: "execution" as const,
  sourceHandle: "bottom" as const, targetHandle: "top" as const, label: "Saved edge label",
  maxWorkHandoffsPerRun: 3, workRequestDirection: "both" as const };
const board = { ...scope, kind: "available" as const, workflowVersionId: "workflow-version-4",
  capturedAt: "2026-09-28T09:59:59.000Z",
  nodes: [node, { ...node, id: "node-b", name: "Another node with the same Agent" }], edges: [edge] };
const chat = { ...scope, workflowNodeId: node.id, agentId: node.agentId, executionId: "execution-1", conversationId: "conversation-1" };
const without = (input: object, key: string) => Object.fromEntries(Object.entries(input).filter(([name]) => name !== key));

describe("Run dropdown contracts", () => {
  it("requires the requested fields, preserving a not-started Run as null", () => {
    expect(RunDropdownSummarySchema.parse(summary)).toEqual(summary);
    expect(RunDropdownSummarySchema.parse({ ...summary, startedAt: null, status: "queued", trigger: "manual" }).startedAt).toBeNull();
    for (const key of Object.keys(summary)) expect(RunDropdownSummarySchema.safeParse(without(summary, key)).success).toBe(false);
    for (const change of [{ runId: "" }, { shortId: "" }, { shortId: "x".repeat(33) },
      { startedAt: "2026-09-28T10:00:00" }, { status: "completed" }, { status: "stopped" }, { trigger: "on_event" }]) {
      expect(RunDropdownSummarySchema.safeParse({ ...summary, ...change }).success).toBe(false);
    }
    expect(RunDropdownSummarySchema.safeParse({ ...summary, credentials: {} }).success).toBe(false);
  });
  it("projects existing Run facts without calling an interrupted Run a failure", () => {
    for (const executionState of ["queued", "running", "waiting", "interrupted"] as const) {
      expect(runDropdownStatus({ executionState, outcome: "pending" })).toBe(executionState);
      expect(RunDropdownStatusSchema.parse(executionState)).toBe(executionState);
    }
    for (const outcome of ["succeeded", "failed", "canceled"] as const) {
      expect(runDropdownStatus({ executionState: "completed", outcome })).toBe(outcome);
      expect(RunDropdownSummarySchema.parse({ ...summary, status: outcome }).status).toBe(outcome);
    }
    expect(runDropdownStatus({ executionState: "interrupted", outcome: "failed" })).toBe("interrupted");
    expect(() => runDropdownStatus({ executionState: "completed", outcome: "pending" })).toThrow(RangeError);
  });
  it("uses scoped, bounded opaque-cursor paging with the existing default of 50", () => {
    const input = { workspaceId: scope.workspaceId, workflowId: scope.workflowId };
    expect(RunDropdownListInputSchema.parse(input)).toEqual({ ...input, limit: 50 });
    expect(RunDropdownListInputSchema.parse({ ...input, limit: 100, cursor: "opaque-page-2" }).cursor).toBe("opaque-page-2");
    for (const limit of [0, -1, 1.5, 101]) expect(RunDropdownListInputSchema.safeParse({ ...input, limit }).success).toBe(false);
    expect(RunDropdownListInputSchema.safeParse({ ...input, cursor: " " }).success).toBe(false);
    expect(RunDropdownListInputSchema.safeParse({ ...input, runId: "not-a-filter" }).success).toBe(false);
    expect(RunDropdownListInputSchema.safeParse(without(input, "workspaceId")).success).toBe(false);
    expect(RunDropdownPageSchema.parse({ items: [], pageInfo: { nextCursor: null } }).items).toEqual([]);
    const page = { items: [summary], pageInfo: { nextCursor: "opaque-page-2" } };
    expect(RunDropdownPageSchema.parse(page)).toEqual(page);
    expect(RunDropdownPageSchema.safeParse({ items: [summary] }).success).toBe(false);
    expect(RunDropdownPageSchema.safeParse({ ...page, pageInfo: { nextCursor: "" } }).success).toBe(false);
    expect(RunDropdownPageSchema.safeParse({ ...page, items: Array.from({ length: 101 }, () => summary) }).success).toBe(false);
  });
  it("never treats the display shortId as a unique Run identity", () => {
    const second = { ...summary, runId: "run-2", shortId: summary.shortId };
    expect(RunDropdownPageSchema.parse({ items: [summary, second], pageInfo: { nextCursor: null } }).items.map((item) => item.runId))
      .toEqual(["run-1", "run-2"]);
  });
});

describe("immutable Run-admission board snapshots", () => {
  it("captures node/version/layout facts and exact current execution/approval edges", () => {
    expect(RunBoardSnapshotSchema.parse(board)).toEqual(board);
    const withApproval = { ...board, edges: [edge, { id: "approval-1", source: "node-b", target: "node-a", kind: "approval",
      sourceHandle: null, targetHandle: "left", label: "Saved approval" }] };
    const parsed = RunBoardSnapshotSchema.parse(withApproval);
    if (parsed.kind !== "available") throw new Error("Expected available fixture");
    expect(parsed.edges).toEqual(withApproval.edges.map((value) => CurrentWorkflowRelationshipSchema.parse(value)));
    const [first, second] = parsed.nodes;
    if (!first || !second || first.kind === "job" || second.kind === "job") throw new Error("Expected Agent fixture");
    expect(first.agentId).toBe(second.agentId);
    expect(parsed.nodes[0]?.id).not.toBe(parsed.nodes[1]?.id);
  });
  it("deep-clones and freezes the admitted board independently of later workflow/Agent edits", () => {
    const source = structuredClone(board);
    const parsed = RunBoardSnapshotSchema.parse(source);
    if (parsed.kind !== "available") throw new Error("Expected available fixture");
    const capturedNode = parsed.nodes[0];
    const capturedEdge = parsed.edges[0];
    if (!capturedNode || !capturedEdge || !source.nodes[0] || !source.edges[0]) throw new Error("Missing fixture data");
    source.nodes[0].name = "Renamed after admission";
    source.nodes[0].agentConfigurationVersionId = "agent-version-8";
    source.nodes[0].position.x = 999;
    source.nodes[0].size.width = 999;
    source.edges[0].label = "Edited edge";
    source.workflowVersionId = "workflow-version-5";
    expect(parsed).toEqual(board);
    for (const value of [parsed, parsed.nodes, parsed.edges, capturedNode, capturedNode.position, capturedNode.size, capturedEdge]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      // @ts-expect-error A historical snapshot's pinned version is immutable.
      parsed.workflowVersionId = "workflow-version-5";
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error Historical board layout is readonly at every level.
      capturedNode.position.x = 999;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error The saved board's node array is readonly.
      parsed.nodes.push(node);
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error Saved edge data is readonly too.
      capturedEdge.label = "Changed";
    }).toThrow(TypeError);
  });
  it("requires complete geometry and pinned identities instead of filling gaps from the live board", () => {
    for (const key of Object.keys(node)) expect(RunBoardNodeSnapshotSchema.safeParse(without(node, key)).success).toBe(false);
    for (const change of [{ agentConfigurationVersionId: "" }, { position: { x: Infinity, y: 0 } },
      { position: { x: 0, y: NaN } }, { size: { width: 0, height: 20 } }, { size: { width: 20, height: -1 } },
      { size: { width: Infinity, height: 20 } }, { size: { width: 20 } }]) {
      expect(RunBoardNodeSnapshotSchema.safeParse({ ...node, ...change }).success).toBe(false);
    }
    for (const key of ["workflowVersionId", "capturedAt", "runId", "workspaceId", "workflowId", "nodes", "edges"]) {
      expect(RunBoardSnapshotSchema.safeParse(without(board, key)).success).toBe(false);
    }
  });
  it("rejects duplicate nodes/edges and dangling endpoints without rewriting the stored graph", () => {
    for (const change of [{ nodes: [...board.nodes, node] }, { edges: [edge, edge] },
      { edges: [{ ...edge, source: "not-captured" }] }, { edges: [{ ...edge, target: "not-captured" }] }]) {
      expect(RunBoardSnapshotSchema.safeParse({ ...board, ...change }).success).toBe(false);
    }
  });
  it("rejects credential/configuration/arbitrary metadata fields at every structured level", () => {
    for (const extra of [{ credentials: { token: "test-only" } }, { environment: { TOKEN: "test-only" } },
      { harnessConfiguration: {} }, { agent: {} }, { prompt: "not a snapshot field" }, { metadata: {} }]) {
      expect(RunBoardSnapshotSchema.safeParse({ ...board, ...extra }).success).toBe(false);
      expect(RunBoardSnapshotSchema.safeParse({ ...board, nodes: board.nodes.map((saved, index) => index === 0 ? { ...saved, ...extra } : saved) }).success).toBe(false);
    }
    expect(RunBoardSnapshotSchema.safeParse({ ...board, edges: [{ ...edge, token: "test-only" }] }).success).toBe(false);
    expect(RunBoardNodeSnapshotSchema.safeParse({ ...node, position: { ...node.position, token: "test-only" } }).success).toBe(false);
    expect(RunBoardNodeSnapshotSchema.safeParse({ ...node, size: { ...node.size, configuration: {} } }).success).toBe(false);
  });
  it("represents legacy Runs as explicitly unavailable, never a reconstructed current board", () => {
    const unavailable = { ...scope, kind: "unavailable", reason: "legacy_run" };
    expect(RunBoardSnapshotSchema.parse(unavailable)).toEqual(unavailable);
    for (const extra of [{ nodes: [] }, { edges: [] }, { workflowVersionId: "current-version" }, { capturedAt: summary.startedAt }]) {
      expect(RunBoardSnapshotSchema.safeParse({ ...unavailable, ...extra }).success).toBe(false);
    }
    expect(RunBoardSnapshotSchema.safeParse(without(unavailable, "reason")).success).toBe(false);
    expect(RunBoardSnapshotSchema.safeParse({ ...unavailable, reason: "use_current_board" }).success).toBe(false);
  });
  it("keeps snapshot reads fully scoped and read-only", () => {
    expect(RunBoardSnapshotGetInputSchema.parse(scope)).toEqual(scope);
    expect(RunBoardSnapshotGetResultSchema.parse({ snapshot: board }).snapshot).toEqual(board);
    for (const key of Object.keys(scope)) expect(RunBoardSnapshotGetInputSchema.safeParse(without(scope, key)).success).toBe(false);
    expect(RunBoardSnapshotGetInputSchema.safeParse({ ...scope, expectedRevision: 1, commandId: "write-command" }).success).toBe(false);
    expect(RunBoardSnapshotGetResultSchema.safeParse({ snapshot: board, credentials: {} }).success).toBe(false);
  });
  it('keeps live activity separate from the immutable Board capture and rejects another Run', () => {
    const activitySnapshot = { schemaVersion: 1, scope: { kind: 'workflow_run', ...scope,
      workflowVersionId: board.workflowVersionId }, revision: '1', active: [], queued: [], latest: null,
      pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } };
    expect(RunBoardSnapshotGetResultSchema.parse({ snapshot: board, activitySnapshot }).snapshot).toEqual(board);
    expect(RunBoardSnapshotGetResultSchema.safeParse({ snapshot: board, activitySnapshot: {
      ...activitySnapshot, scope: { ...activitySnapshot.scope, runId: 'another-run' } } }).success).toBe(false);
  });
});

describe("selected-Run chat identity", () => {
  it("requires all seven identities, with no current-Run or current-conversation fallback", () => {
    expect(SelectedRunChatKeySchema.parse(chat)).toEqual(chat);
    for (const key of Object.keys(chat)) {
      expect(SelectedRunChatKeySchema.safeParse(without(chat, key)).success).toBe(false);
      expect(SelectedRunChatKeySchema.safeParse({ ...chat, [key]: null }).success).toBe(false);
      expect(SelectedRunChatKeySchema.safeParse({ ...chat, [key]: " " }).success).toBe(false);
    }
    expect(SelectedRunChatKeySchema.safeParse({ ...chat, shortId: "display-id" }).success).toBe(false);
    expect(SelectedRunChatKeySchema.safeParse({ ...chat, credentials: {} }).success).toBe(false);
  });
  it("distinguishes every scope, repeated execution, and forked conversation component", () => {
    const identities = [chat, ...Object.keys(chat).map((key) => ({ ...chat, [key]: "different-identity" }))];
    const parsed = identities.map((key) => SelectedRunChatKeySchema.parse(key));
    expect(new Set(parsed.map((key) => JSON.stringify(key))).size).toBe(8);
    expect(Object.isFrozen(parsed[0])).toBe(true);
  });
});
