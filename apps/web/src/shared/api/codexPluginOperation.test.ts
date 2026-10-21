import { expect, it } from 'vitest'
import { reservePluginOperation, pluginOperationFailed, pluginOperationSucceeded } from './codexPluginOperation'

const input = { pluginId: 'notes@trusted', action: 'install' as const, expectedRevision: 'sha256:' + 'a'.repeat(64), artifactIdentity: 'sha256:' + 'b'.repeat(64), commandId: '00000000-0000-4000-8000-000000000001' }
it('retains the exact original payload through uncertain errors and subsequent denial', () => {
  const first = pluginOperationFailed(reservePluginOperation(input), new Error('Network dropped'))!
  const denied = pluginOperationFailed(first, Object.assign(new Error('Denied'), { status: 403, code: 'ACCESS_DENIED' }))!
  expect(denied.input).toEqual(input)
  expect(denied.uncertainDelivery).toBe(true)
})
it('clears only a definitive rejection before any possible acceptance', () => {
  expect(pluginOperationFailed(reservePluginOperation(input), { status: 409, code: 'REVISION_CONFLICT' })).toBeNull()
})
it('retains an uncertain receipt and clears a definitively reconciled result', () => {
  const pending = pluginOperationSucceeded(reservePluginOperation(input), { pluginId: input.pluginId, action: input.action, status: 'uncertain', message: 'Unknown' })!
  expect(pending.input).toEqual(input)
  expect(pluginOperationSucceeded(pending, { pluginId: input.pluginId, action: input.action, status: 'reconciled', message: 'Kept observed state without a write' })).toBeNull()
})

it.each([401, 403])('retains an original command when the first response is %s after possible acceptance', (status) => {
  const result = pluginOperationFailed(reservePluginOperation(input), { status, code: 'ACCESS_DENIED' })
  expect(result?.input).toEqual(input)
  expect(result?.uncertainDelivery).toBe(true)
})
