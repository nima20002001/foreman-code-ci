import type {
  CallToolResult, McpServer, ServerContext, StandardSchemaWithJSON, ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { ManagementAction, ManagementScope, OperatorToolName } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import type { OperatorCatalog } from './presentation.js'
import type { OperatorRequestContext, OperatorServices } from './types.js'

/**
 * One declarative Operator MCP tool. Its definition is the single source of truth for the
 * tool catalog, discovery (tools/list), operator_get_capabilities, permission requirements,
 * denial classification and the handler. See catalog.ts for how to add a tool.
 */
export type ScopeKind = 'global' | 'workspace' | 'workflow' | 'run' | 'resource' | 'caller'
export type ToolGrant = readonly [action: ManagementAction, scope: ScopeKind]
export interface Requirement { action: ManagementAction; scope: ScopeKind }

/** Per-call values beyond the input. tools is the whole registry, for introspection tools. */
export interface OperatorToolCall {
  extra: ServerContext
  catalog?: OperatorCatalog
  tools: readonly OperatorToolDefinition[]
}
type Input<I extends StandardSchemaWithJSON> = StandardSchemaWithJSON.InferOutput<I>

interface ToolMetadata<I extends StandardSchemaWithJSON> {
  name: OperatorToolName
  /** Every grant a caller needs to discover the tool, scoped compatibly. The first is the tool's own action. */
  requires: readonly [ToolGrant, ...ToolGrant[]]
  /** Composed services the tool needs. Without them it is not discovered. */
  enabled?: (services: OperatorServices) => boolean
  /** Replaces the compatible-grant check when the tool's grants are alternatives. */
  discoverable?: (context: OperatorRequestContext, resource?: AuthorizedResource) => boolean
  /** operator_get_capabilities detail for this tool's requirements, when the default one is not enough. */
  permissionDetail?: string
  description: string
  inputSchema: I
  outputSchema?: StandardSchemaWithJSON
  annotations: ToolAnnotations
}
/** run: the result becomes structured content; failures are classified, logged and denial-audited. */
interface RunTool<I extends StandardSchemaWithJSON> extends ToolMetadata<I> {
  run(context: OperatorRequestContext, input: Input<I>, call: OperatorToolCall): Promise<unknown>
  handle?: undefined
}
/** handle: the tool returns its own MCP result. */
interface HandleTool<I extends StandardSchemaWithJSON> extends ToolMetadata<I> {
  handle(context: OperatorRequestContext, input: Input<I>, call: OperatorToolCall): CallToolResult | Promise<CallToolResult>
  run?: undefined
}
export type OperatorToolDefinition<I extends StandardSchemaWithJSON = StandardSchemaWithJSON> = RunTool<I> | HandleTool<I>

export function defineOperatorTool<I extends StandardSchemaWithJSON>(definition: OperatorToolDefinition<I>): OperatorToolDefinition {
  return definition as unknown as OperatorToolDefinition
}

/** requires from a service's own requirement list, so the tool and the service cannot drift. */
export function grants(requirements: readonly Requirement[]): readonly [ToolGrant, ...ToolGrant[]] {
  const [first, ...rest] = requirements.map(({ action, scope }) => [action, scope] as const)
  if (!first) throw new Error('An Operator tool requires at least one grant.')
  return [first, ...rest]
}

export function toolRequirements(tool: OperatorToolDefinition): Requirement[] {
  return tool.requires.map(([action, scope]) => ({ action, scope }))
}

function projected(resource: AuthorizedResource, kind: ScopeKind): AuthorizedResource {
  if (kind === 'global' || kind === 'caller') return {}
  if (kind === 'workspace') return resource.workspaceId ? {workspaceId:resource.workspaceId} : {}
  if (kind === 'workflow') return {...(resource.workspaceId?{workspaceId:resource.workspaceId}:{}),...(resource.workflowId?{workflowId:resource.workflowId}:{})}
  return resource
}
function usable(scope: ManagementScope, kind: ScopeKind): boolean {
  if (Object.values(scope).some((ids) => ids?.length === 0)) return false
  if (kind === 'global') return Object.values(scope).every(ids => ids === undefined)
  if (kind === 'workspace') return !scope.workflowIds && !scope.runIds
  if (kind === 'workflow') return !scope.runIds
  return true
}
function intersect(left: ManagementScope, right: ManagementScope): ManagementScope | undefined {
  const result: ManagementScope = {}
  for (const dimension of ['workspaceIds','workflowIds','runIds', 'mainIds', 'deviceIds',
    'applicationInstallationIds', 'providerAccountIds'] as const) {
    const a=left[dimension],b=right[dimension]
    const ids=a&&b ? a.filter((id)=>b.includes(id)) : a??b
    if (ids?.length===0) return undefined
    if (ids) result[dimension]=ids
  }
  return result
}

/** Discovery only: services recheck the live grant and concrete resource on every call. */
export function toolAvailable(context: OperatorRequestContext, tool: OperatorToolDefinition, resource?: AuthorizedResource): boolean {
  if (tool.enabled && !tool.enabled(context.services)) return false
  if (tool.discoverable) return tool.discoverable(context, resource)
  const requirements = toolRequirements(tool)
  if (resource && Object.keys(resource).length) return requirements.every((requirement)=>
    requirement.scope==='caller' ? hasAction(context.principal,requirement.action)
      : isAuthorized(context.principal,requirement.action,projected(resource,requirement.scope)))
  // Require compatible grant scopes, not an action on one workspace plus a
  // dependent permission on a disjoint workspace. Bound branching for a large
  // grant set by returning a conservative unavailable result, never broadening.
  let scopes: ManagementScope[]=[{}]
  for(const requirement of requirements) {
    if (!hasAction(context.principal,requirement.action)) return false
    if (requirement.scope==='caller') continue
    const grants=context.principal.grants.filter((grant)=>grant.actions.includes(requirement.action)&&usable(grant.scope,requirement.scope))
    const next:ManagementScope[]=[]
    for(const scope of scopes) for(const grant of grants) {
      const combined=intersect(scope,grant.scope)
      if (combined) next.push(combined)
      if (next.length>10_000) return false
    }
    if (!next.length) return false
    scopes=next
  }
  return true
}

export type InvokeOperatorTool = (context: OperatorRequestContext, name: OperatorToolName,
  work: () => Promise<unknown>, action: ManagementAction) => Promise<CallToolResult>

/** Registers one definition as is. Discovery filtering belongs to the caller. */
export function registerToolDefinition(server: McpServer, context: OperatorRequestContext, tool: OperatorToolDefinition,
  options: { invoke?: InvokeOperatorTool; catalog?: OperatorCatalog | undefined; tools?: readonly OperatorToolDefinition[] } = {}): void {
  const invoke = options.invoke
  if (tool.run && !invoke) throw new Error(`Operator tool ${tool.name} needs the shared invocation wrapper.`)
  server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: tool.annotations,
  }, (input: unknown, extra: ServerContext) => {
    const call: OperatorToolCall = { extra, tools: options.tools ?? [], ...(options.catalog ? { catalog: options.catalog } : {}) }
    if (tool.handle) return tool.handle(context, input, call)
    return invoke!(context, tool.name, () => tool.run!(context, input, call), tool.requires[0][0])
  })
}
