import { describe, expect, it } from "vitest";

import {
  GraphDraftApplyInputSchema,
  ManagementPrincipalSchema,
  RunStartInputSchema,
  WorkspaceUpdateInputSchema,
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationValidateInputSchema,
  OperatorCapabilitiesSchema,
  InteractionListInputSchema,
} from "../src/management/index.js";

describe("management contracts", () => {
  it("rejects unknown fields and malformed scopes", () => {
    expect(() => ManagementPrincipalSchema.parse({
      id: "principal-1", name: "Owner", audience: "operator", expiresAt: "2026-10-01T00:00:00.000Z",
      revokedAt: null, grants: [{ actions: ["workspaces:read"], scope: {}, extra: true }],
    })).toThrow();
  });

  it("requires revisions for metadata writes", () => {
    expect(() => WorkspaceUpdateInputSchema.parse({
      workspaceId: "workspace-1", commandId: "command-123", name: "Renamed",
    })).toThrow();
  });

  it("accepts strict typed graph batches and rejects arbitrary patch operations", () => {
    const base = {
      workspaceId: "workspace-1", workflowId: "workflow-1", draftId: "draft-1",
      commandId: "command-123", expectedRevision: 2,
    };
    expect(GraphDraftApplyInputSchema.parse({
      ...base,
      operations: [{ type: "node.move", nodeId: "node-1", position: { x: 10, y: 20 } }],
    }).operations).toHaveLength(1);
    expect(() => GraphDraftApplyInputSchema.parse({
      ...base,
      operations: [{ type: "json.patch", path: "/name", value: "unsafe" }],
    })).toThrow();
  });

  it("requires an explicit saved workflow version when starting", () => {
    expect(() => RunStartInputSchema.parse({
      workspaceId: "workspace-1", workflowId: "workflow-1", commandId: "command-123", input: {},
    })).toThrow();
  });

  it("keeps workspace metadata writes separate from privileged location commands", () => {
    expect(() => WorkspaceUpdateInputSchema.parse({
      workspaceId: "workspace-1", commandId: "command-123", expectedRevision: 1,
      rootPath: "/tmp/project",
    })).toThrow();
    expect(WorkspaceLocationValidateInputSchema.parse({
      workspaceId: "workspace-1", runnerId: "runner-local", rootPath: "/tmp/project",
    })).toMatchObject({ accessMode: "read-only" });
    expect(WorkspaceLocationSetInputSchema.parse({
      workspaceId: "workspace-1", runnerId: "runner-local", rootPath: "/tmp/project",
      expectedLocationRevision: 2, commandId: "command-123",
    })).toMatchObject({ expectedLocationRevision: 2 });
    expect(() => WorkspaceLocationSetInputSchema.parse({
      workspaceId: "workspace-1", runnerId: "runner-local", rootPath: "/tmp/project",
      expectedRevision: 2, commandId: "command-123",
    })).toThrow();
  });

  it("supports truthful App MCP capability and scoped interaction tools", () => {
    expect(OperatorCapabilitiesSchema.parse({
      endpoint: "/mcp", audience: "operator", protocol: "2026-07-28", tools: [],
      workerToolsMcp: { implemented: true, endpoint: "/mcp" },
    }).workerToolsMcp.implemented).toBe(true);
    expect(InteractionListInputSchema.parse({ workspaceId: "workspace-1", workflowId: "workflow-1", status: "pending" })).toMatchObject({ limit: 50 });
  });
});
