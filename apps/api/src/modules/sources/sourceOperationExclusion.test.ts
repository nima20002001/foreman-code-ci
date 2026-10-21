import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { withSourceOperationExclusion } from './sourceOperationExclusion.js'

it('runs work for one source operation one at a time and in arrival order', async () => {
  const events: string[] = []
  const gate = deferred<void>()
  const first = withSourceOperationExclusion('operation', async () => {
    events.push('first start')
    await gate.promise
    events.push('first end')
  })
  const second = withSourceOperationExclusion('operation', async () => { events.push('second') })
  const third = withSourceOperationExclusion('operation', async () => { events.push('third') })
  await new Promise(resolve => setImmediate(resolve))
  expect(events).toEqual(['first start'])
  gate.resolve()
  await Promise.all([first, second, third])
  expect(events).toEqual(['first start', 'first end', 'second', 'third'])
})

it('lets other source operations proceed and releases after a failure', async () => {
  const gate = deferred<void>()
  const held = withSourceOperationExclusion('held', () => gate.promise)
  expect(await withSourceOperationExclusion('other', async () => 'other done')).toBe('other done')
  await expect(withSourceOperationExclusion('failing', async () => { throw new Error('boom') })).rejects.toThrow('boom')
  expect(await withSourceOperationExclusion('failing', async () => 'again')).toBe('again')
  gate.resolve()
  await held
})
