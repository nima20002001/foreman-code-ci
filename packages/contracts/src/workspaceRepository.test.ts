import { expect, it } from 'vitest'
import { WorkspaceRepositorySchema } from './workspaceRepository.js'

const repository = { provider: 'github', owner: 'octo-owner', name: 'website' }

it.each(['release..stable', 'release/', 'release.lock', 'feature:broken', '', '/main',
  'feature//change', '.hidden', 'feature/.hidden', 'feature.lock/change', 'main.', '@',
  'feature@{change', '-main', 'feature\u007fchange', 'feature\u0000change', 'feature\\change'])('rejects invalid Git base branch %j at its field', defaultBranch => {
  const result = WorkspaceRepositorySchema.safeParse({ ...repository, defaultBranch })
  expect(result.success).toBe(false)
  if (!result.success) expect(result.error.issues.every(issue => issue.path[0] === 'defaultBranch')).toBe(true)
})

it.each(['main', 'release-v1', 'release/v1.2', 'feature/my-change'])('accepts Git base branch %s', defaultBranch => {
  expect(WorkspaceRepositorySchema.parse({ ...repository, defaultBranch }).defaultBranch).toBe(defaultBranch)
})
