/** Denial-only identifiers for a retired execution adapter.
 * No success schema, parser, conversion or V3 fallback is exported here.
 * Current clients use the bounded V3 Run/graph/inspection contracts in wave25. */
export const RUN_CURRENT_ROUTE = '/api/management/workspaces/:workspaceId/runs/:runId/current'
export const RUN_CURRENT_MCP_TOOL = 'run_current_get_v1'
