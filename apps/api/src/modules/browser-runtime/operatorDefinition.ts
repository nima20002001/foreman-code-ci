import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import type { OperatorToolDefinition } from '../../mcp/operator/definition.js'
import type { BrowserOperationName } from './operations.js'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'

/** The shared registry binds these descriptors after adding the canonical browser tool names. */
export type BrowserOperatorToolDefinition = Omit<
  Extract<OperatorToolDefinition<StandardSchemaWithJSON>, { run: unknown }>, 'name' | 'run'
> & {
  name: BrowserOperationName
  run(context: OperatorRequestContext, input: unknown): Promise<unknown>
}
