import { WORKER_MCP_REQUEST_MAX_BYTES } from '@foreman-code/contracts/worker-mcp-relay'

// Shared transport limit keeps full-sized inline uploads usable.
export const MAX_REFERENCE_MCP_BODY_BYTES = WORKER_MCP_REQUEST_MAX_BYTES
