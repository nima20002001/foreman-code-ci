import { expect, it, vi } from 'vitest'
import { runOwnedClaudeOperation } from './ownedOperation.js'

it('returns native output only after its original owner closes', async () => {
  const order: string[] = []
  const result = await runOwnedClaudeOperation(async () => { order.push('operation'); return 'native-output' },
    async () => { order.push('closed') })
  expect(result).toBe('native-output')
  expect(order).toEqual(['operation', 'closed'])
})

it('preserves the operation error and still closes its owner', async () => {
  const failure = new Error('Native failure')
  const close = vi.fn(async () => {})
  await expect(runOwnedClaudeOperation(async () => { throw failure }, close)).rejects.toBe(failure)
  expect(close).toHaveBeenCalledTimes(1)
  await expect(runOwnedClaudeOperation(() => { throw failure }, close)).rejects.toBe(failure)
  expect(close).toHaveBeenCalledTimes(2)
})

it('retains both errors when native operation and closure fail', async () => {
  const operation = new Error('Native failure')
  const cleanup = new Error('Native closure unconfirmed')
  const result = runOwnedClaudeOperation(async () => { throw operation }, async () => { throw cleanup })
  await expect(result).rejects.toMatchObject({ errors: [operation, cleanup], cause: cleanup })
  await expect(runOwnedClaudeOperation(async () => 'native-output', async () => { throw cleanup })).rejects.toBe(cleanup)
})
