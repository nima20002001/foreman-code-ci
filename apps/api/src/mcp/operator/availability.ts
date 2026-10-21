import type { OperatorToolName } from '@foreman-code/contracts/management'
import type { AuthorizedResource } from '../../modules/access/policy.js'
import { operatorTool } from './catalog.js'
import { toolAvailable, toolRequirements, type Requirement } from './definition.js'
import { retiredExecutionTool } from './retiredExecutionTools.js'
import type { OperatorRequestContext } from './types.js'

export { TELEMETRY_READ_ACTIONS } from './resourceTelemetry.js'

/** Requirements come from the tool's registry definition (catalog.ts). */
export function operatorToolRequirements(name: OperatorToolName, resource?: AuthorizedResource): Requirement[] {
  void resource
  const tool = operatorTool(name)
  return tool ? toolRequirements(tool) : []
}

export function operatorToolAvailable(context: OperatorRequestContext, name: OperatorToolName, resource?: AuthorizedResource): boolean {
  if (retiredExecutionTool(name)) return false
  const tool = operatorTool(name)
  return !!tool && toolAvailable(context, tool, resource)
}
