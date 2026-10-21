/** Denial-only identifiers for a retired execution adapter.
 * Do not reinterpret latest-per-node legacy history as current V3 history.
 * Current clients use the bounded V3 Run/graph/inspection contracts in wave25. */
export const RUN_HISTORY_ROUTE = '/api/management/workspaces/:workspaceId/runs/:runId/historical'
export const RUN_HISTORY_MCP_TOOL = 'run_history_get_v1'
