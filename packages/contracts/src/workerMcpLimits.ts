import { MAX_FILE_BYTES } from './files.js'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES } from './sourceMaterialization.js'

/** One full 2 MiB manifest plus metadata, doubled for JSON text escaping in approval responses. */
export const WORKER_MCP_RESPONSE_MAX_BYTES = 2 * SOURCE_MATERIALIZATION_RECORD_MAX_BYTES
export const WORKER_MCP_REQUEST_MAX_BYTES = 4 * Math.ceil(MAX_FILE_BYTES / 3) + 64 * 1024
/** At 100 ms RTT this carries a full reference in about ten seconds, with a bounded 256 KiB window. */
export const WORKER_MCP_CHUNK_WINDOW = 32
export const WORKER_MCP_EXTENSION = {
  namespace: 'worker-mcp-v2', version: 2, maxJsonBytes: 1_048_576, maxBinaryBytes: Math.max(WORKER_MCP_RESPONSE_MAX_BYTES, WORKER_MCP_REQUEST_MAX_BYTES),
} as const
