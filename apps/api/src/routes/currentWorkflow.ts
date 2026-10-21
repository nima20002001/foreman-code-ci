import type { FastifyInstance } from 'fastify'
import {
  CURRENT_WORKFLOW_ROUTES, CurrentWorkflowReadInputSchema, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowValidateInputSchema, CurrentEditReadInputSchema, CurrentEditMutationInputSchema,
} from '@foreman-code/contracts/wave25'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { RunManagementService } from '../modules/runs/management.js'
import type { WorkflowManagementService } from '../modules/workflows/management.js'

type Params = { workspaceId: string; workflowId: string }
function scoped(params: Params, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('INVALID_INPUT', 'A definition request must be an object.', 400)
  const value = body as Record<string, unknown>
  if (value.workspaceId !== undefined && value.workspaceId !== params.workspaceId
    || value.workflowId !== undefined && value.workflowId !== params.workflowId) {
    throw new DomainError('RESOURCE_ID_MISMATCH', 'The definition body must match its URL scope.', 400)
  }
  return { ...value, ...params }
}
export function registerCurrentWorkflowRoutes(app: FastifyInstance, workflows: WorkflowManagementService, runs?: RunManagementService) {
  if (!workflows?.current) return
  if (runs) workflows.current.bindEditStop(runs.stop.bind(runs), runs)
  app.get(CURRENT_WORKFLOW_ROUTES.capabilities, async (request) => workflows.current.capabilities(requirePrincipal(request)))
  app.get<{ Params: Params; Querystring: unknown }>(CURRENT_WORKFLOW_ROUTES.saved, async (request) => {
    const query = CurrentWorkflowReadInputSchema.pick({ workflowVersionId: true }).strict().parse(request.query)
    return workflows.current.read(requirePrincipal(request), { ...request.params, ...query })
  })
  app.get<{ Params: Params; Querystring: unknown }>(CURRENT_WORKFLOW_ROUTES.edits, async (request) => {
    const query = CurrentEditReadInputSchema.pick({ draftId: true, intentId: true }).strict().parse(request.query)
    return workflows.current.readEdits(requirePrincipal(request), { ...request.params, ...query, action: 'read_edits' })
  })
  app.post<{ Params: Params; Body: unknown }>(CURRENT_WORKFLOW_ROUTES.edits, async (request) =>
    workflows.current.mutateEdits(requirePrincipal(request), 'http', CurrentEditMutationInputSchema.parse(scoped(request.params, request.body))))
  app.post<{ Params: Params; Body: unknown }>(CURRENT_WORKFLOW_ROUTES.validate, async (request) =>
    workflows.current.validate(requirePrincipal(request), CurrentWorkflowValidateInputSchema.parse(scoped(request.params, request.body))))
  app.put<{ Params: Params; Body: unknown }>(CURRENT_WORKFLOW_ROUTES.saved, async (request) =>
    workflows.current.save(requirePrincipal(request), 'http', CurrentWorkflowSaveInputSchema.parse(scoped(request.params, request.body))))
}
