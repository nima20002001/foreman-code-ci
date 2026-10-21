import { browserOperatorTools } from '../../modules/collaboration/browserTools.js'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS, CURRENT_WORKFLOW_TOOLS, RUN_INSPECTION_TOOLS } from '@foreman-code/contracts/wave25'
import { WORKFLOW_HIERARCHY_TOOLS } from '@foreman-code/contracts'
import { toolAvailable, toolRequirements, type OperatorToolDefinition } from './definition.js'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import type { OperatorRequestContext } from './types.js'
import { hostHarnessToolAvailable, HOST_HARNESS_TOOLS } from '../../modules/harnesses/instanceSettings/management.js'
import { currentWorkflowRequirements, currentWorkflowAvailable } from '../../modules/workflows/currentWorkflowPolicy.js'
import { CI_TOOLS, ciCapabilities } from '../shared/ciTools.js'
import { JOB_TOOLS, jobToolAvailable, jobCapabilities } from './tools/jobs.js'
import { JOB_RUNTIME_TOOLS, jobRuntimeToolAvailable, jobRuntimeCapabilities } from './tools/jobRuntimeProfiles.js'
import { FILE_REFERENCE_TOOL_NAMES, fileReferenceToolAvailable } from './tools/fileReferences.js'
import { FILE_RETENTION_TOOL_NAMES, fileRetentionToolAvailable } from './tools/fileRetention.js'
import { WORKFLOW_SCHEDULE_TOOLS, workflowScheduleToolAvailable, workflowScheduleCapabilities } from './tools/workflowSchedules.js'
import { RUN_HISTORY_TOOLS, runHistoryToolsAvailable, runHistoryToolAvailable } from './tools/runHistory.js'
import { runInspectionToolAvailable, runInspectionRequirements } from './tools/runInspection.js'
import { runGraphToolAvailable } from './tools/runGraph.js'
import { workflowHierarchyToolAvailable } from './tools/workflowHierarchy.js'

/** Uses the registrars' existing discovery predicates with the current authenticated caller. */
export function catalogToolAvailable(context: OperatorRequestContext, name: string,
  registry: readonly OperatorToolDefinition[], resource: AuthorizedResource = {}): boolean {
  const tool = registry.find(candidate => candidate.name === name)
    ?? browserOperatorTools(context).find(candidate => candidate.name === name)
  if (tool) return toolAvailable(context, tool, resource)
  if (name === 'workspace_root_configuration_adopt') return workspaceRootAdoptionAvailable(context, registry, resource)
  const host = HOST_HARNESS_TOOLS.find(candidate => candidate === name)
  if (host) return hostHarnessToolAvailable(context.services.harnessInstances, context.principal, host)
  if (CI_TOOLS.some(candidate => candidate === name)) return ciCapabilities(context, resource).some(tool => tool.name === name)
  const job = JOB_TOOLS.find(candidate => candidate === name)
  if (job) return jobToolAvailable(context, job, resource)
  const runtime = JOB_RUNTIME_TOOLS.find(candidate => candidate === name)
  if (runtime) return jobRuntimeToolAvailable(context, runtime, resource)
  const reference = FILE_REFERENCE_TOOL_NAMES.find(candidate => candidate === name)
  if (reference) return fileReferenceToolAvailable(context, reference, resource)
  const retention = FILE_RETENTION_TOOL_NAMES.find(candidate => candidate === name)
  if (retention) return fileRetentionToolAvailable(context, retention)
  const schedule = WORKFLOW_SCHEDULE_TOOLS.find(candidate => candidate === name)
  if (schedule) return workflowScheduleToolAvailable(context, schedule, resource)
  const operation = (Object.keys(CURRENT_WORKFLOW_TOOLS) as Array<keyof typeof CURRENT_WORKFLOW_TOOLS>)
    .find(key => CURRENT_WORKFLOW_TOOLS[key] === name)
  if (operation) return !!context.services.workflows?.current && currentWorkflowAvailable(context.principal, operation, resource)
  const hierarchy = Object.values(WORKFLOW_HIERARCHY_TOOLS).find(candidate => candidate === name)
  if (hierarchy) return workflowHierarchyToolAvailable(context, hierarchy)
  const history = Object.values(RUN_HISTORY_TOOLS).find(candidate => candidate === name)
  if (history) return Object.keys(resource).length
    ? runHistoryToolAvailable(context, history, resource) : runHistoryToolsAvailable(context)
  const inspection = Object.values(RUN_INSPECTION_TOOLS).find(candidate => candidate === name)
  if (inspection) return runInspectionToolAvailable(context, inspection, resource)
  if (Object.values(CANONICAL_RUN_GRAPH_MCP_TOOLS).some(candidate => candidate === name)) {
    return runGraphToolAvailable(context, name) && (Object.keys(resource).length
      ? isAuthorized(context.principal, 'runs:read', resource) : hasAction(context.principal, 'runs:read'))
  }
  return false
}

/** Adoption and root selection use the same workspace location update authorization. */
function workspaceRootAdoptionAvailable(context: OperatorRequestContext, registry: readonly OperatorToolDefinition[],
  resource: AuthorizedResource): boolean {
  if (!context.services.workspaceRoots) return false
  const write = registry.find(tool => tool.name === 'workspace_root_location_set')
  if (!write) return false
  const workspaces = resource.workspaceId ? [resource.workspaceId]
    : [undefined, ...new Set(context.principal.grants.flatMap(grant => grant.scope.workspaceIds ?? []))]
  return workspaces.some(workspaceId => write.requires.every(([action]) =>
    isAuthorized(context.principal, action, workspaceId ? { workspaceId } : {})))
}

export interface CapabilityRequirement { name: string; actions: ManagementAction[]; detail: string }

/** Metadata for registered tools whose owning modules still use direct registrars. */
function extensionRequirements(): CapabilityRequirement[] {
  const hostActions: Record<typeof HOST_HARNESS_TOOLS[number], ManagementAction[]> = {
    harness_instances_list: ['harnesses:read'], harness_instance_save: ['harnesses:update'],
    harness_instance_check: ['harnesses:read', 'harnesses:update'],
  }
  const host = HOST_HARNESS_TOOLS.map(name => ({ name, actions: hostActions[name],
    detail: 'Requires unscoped harness actions before checking the selected host and installation. Checking requires a composed qualification service.',
  }))
  const references = FILE_REFERENCE_TOOL_NAMES.map(name => {
    const write = name === 'reference_file_add' || name === 'reference_file_remove'
    const actions: ManagementAction[] = ['workspaces:read', 'workflows:read']
    if (write) actions.push('workspaces:update', 'workflows:update')
    return { name, actions,
      detail: 'Actions list scope alternatives: workspace_reference requires workspaces:read'
        + (write ? ' and workspaces:update' : '') + '; workflow_reference requires workflows:read'
        + (write ? ' and workflows:update' : '') + '. Grants must overlap for the selected resource. Operator-only.',
    }
  })
  return [...host, ...references, {
    name: 'workspace_root_configuration_adopt',
    actions: ['source_roots:read', 'source_roots:bind', 'workspace_locations:read',
      'workspace_locations:validate', 'workspace_locations:update'],
    detail: 'Requires all listed actions on the workspace. Adopts the selected authenticated host configuration; does not grant host authority.',
  }, ...FILE_RETENTION_TOOL_NAMES.map(name => ({ name,
    actions: name === 'file_retention_save' ? ['settings:read' as const, 'settings:update' as const]
      : ['settings:read' as const],
    detail: 'Requires unscoped settings grants and a non-delegated human-owner credential belonging to the caller. Live ownership is rechecked by the service.',
  })), ...Object.values(RUN_HISTORY_TOOLS).map(name => ({ name, actions: ['runs:read' as const],
    detail: 'Requires live runs:read for the persisted workspace/workflow/Run hierarchy. Run-only grants see only their Runs.',
  }))]
}

/** Project requirements in registered catalog order; missing metadata is a configuration error. */
export function catalogToolRequirements(context: OperatorRequestContext, registry: readonly OperatorToolDefinition[],
  names: readonly string[], resource: AuthorizedResource): CapabilityRequirement[] {
  const ordinary = [...registry, ...browserOperatorTools(context)].map(tool => ({ name: tool.name,
    actions: toolRequirements(tool).map(item => item.action),
    detail: tool.permissionDetail ?? 'Requirements are scoped independently. Services revalidate every concrete operation.',
  }))
  const current = (Object.keys(CURRENT_WORKFLOW_TOOLS) as Array<keyof typeof CURRENT_WORKFLOW_TOOLS>).map(operation => ({
    name: CURRENT_WORKFLOW_TOOLS[operation], actions: currentWorkflowRequirements[operation].map(item => item.action),
    detail: 'Concrete services recheck scope and saved configuration; Stop also requires each affected Run grant.',
  }))
  const graph = Object.values(CANONICAL_RUN_GRAPH_MCP_TOOLS).map(name => ({ name,
    actions: name === CANONICAL_RUN_GRAPH_MCP_TOOLS.capabilities || name === CANONICAL_RUN_GRAPH_MCP_TOOLS.readCapabilities
      ? ['runs:read' as const, 'capabilities:read' as const] : ['runs:read' as const],
    detail: 'Requires the persisted Run/workflow/version scope. Metadata reads do not grant execution authority.',
  }))
  const inspection = Object.values(RUN_INSPECTION_TOOLS).map(name => ({ name, actions: runInspectionRequirements(name),
    detail: 'Requires runs:read on the persisted Run; run_version_get additionally requires workflows:read on its workflow.',
  }))
  const requirements = new Map([...ordinary, ...current, ...graph, ...inspection,
    ...workflowScheduleCapabilities(context, resource), ...jobCapabilities(context, resource),
    ...ciCapabilities(context, resource), ...jobRuntimeCapabilities(context, resource), ...extensionRequirements(),
  ].map(entry => [entry.name, entry]))
  return names.map(name => {
    const requirement = requirements.get(name)
    if (!requirement) throw new Error(`Registered Operator tool lacks permission metadata: ${name}`)
    return requirement
  })
}
