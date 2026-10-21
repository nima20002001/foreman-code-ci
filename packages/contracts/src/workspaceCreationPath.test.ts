import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkspaceCreateInputSchema } from './management/index.js'

it('preserves existing parent path bytes while normalizing the new workspace name', () => {
  const parentPath = '/projects/Selected '
  const input = WorkspaceCreateInputSchema.parse({ commandId: randomUUID(), parentPath, name: ' Project ' })
  expect(input.parentPath).toBe(parentPath)
  expect(input.name).toBe('Project')
})

it.each(['', '/projects/invalid\0path'])('rejects invalid parent paths without changing their identity: %s', parentPath => {
  expect(WorkspaceCreateInputSchema.safeParse({ commandId: randomUUID(), parentPath }).success).toBe(false)
})
