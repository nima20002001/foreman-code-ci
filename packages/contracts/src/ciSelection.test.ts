import { expect, it } from 'vitest'
import { CiRunInputSchema, OperatorCiRunInputSchema } from './ci.js'
import { CiHostRequestSchema, CiPartitionSchema, CiSelectedFilesSchema } from './ciHost.js'

const input = { suite: 'unit', scope: 'affected', files: ['apps/api/src/feature.test.ts'],
  commit: 'a'.repeat(40), commandId: 'affected' }

it('preserves host partition indexes and rejects invalid or duplicate indexes', () => {
  const partition = { index: 1, count: 3, weights: [1, 2, 2], hostIndexes: [0] }
  expect(CiPartitionSchema.parse(partition)).toEqual(partition)
  expect(CiHostRequestSchema.parse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
    repository: 'example/project', commit: input.commit, suite: 'integration', partition })).toMatchObject({ partition })
  for (const hostIndexes of [[], [0, 0], [-1], [3], [0.5]]) {
    expect(CiPartitionSchema.safeParse({ ...partition, hostIndexes }).success).toBe(false)
  }
})

it('accepts a full base SHA through Agent, Operator and host contracts and rejects abbreviated or invalid bases', () => {
  for (const baseCommit of ['b'.repeat(40), 'b'.repeat(64)]) {
    const request = { suite: 'unit', commandId: 'release-changes', baseCommit }
    expect(CiRunInputSchema.parse(request)).toEqual(request)
    expect(OperatorCiRunInputSchema.parse({ ...request, workspaceId: 'workspace-ci' })).toMatchObject(request)
    expect(CiHostRequestSchema.parse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
      repository: 'example/project', commit: input.commit, suite: request.suite, baseCommit })).toMatchObject({ baseCommit })
  }
  for (const baseCommit of ['abcd123', 'g'.repeat(40), 'HEAD']) {
    const request = { suite: 'unit', commandId: 'invalid-base', baseCommit }
    expect(CiRunInputSchema.safeParse(request).success).toBe(false)
    expect(OperatorCiRunInputSchema.safeParse({ ...request, workspaceId: 'workspace-ci' }).success).toBe(false)
    expect(CiHostRequestSchema.safeParse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
      repository: 'example/project', commit: input.commit, suite: request.suite, baseCommit }).success).toBe(false)
  }
})

it('accepts affected scope through Agent, Operator and host contracts', () => {
  expect(CiRunInputSchema.parse(input)).toEqual(input)
  expect(OperatorCiRunInputSchema.parse({ ...input, workspaceId: 'workspace-ci' })).toMatchObject(input)
  expect(CiHostRequestSchema.parse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
    repository: 'example/project', suite: input.suite, commit: input.commit, scope: input.scope, files: input.files }))
    .toMatchObject({ scope: 'affected', files: input.files })
})

it('accepts execution parts with their suite and permits shards only on unit-api, unit-web and unit-web-heavy', () => {
  const start = { operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
    repository: 'example/project', suite: 'unit', commit: 'a'.repeat(40), part: 'unit-api',
    partition: { index: 0, count: 5 } }
  expect(CiHostRequestSchema.parse(start)).toMatchObject({ part: 'unit-api', partition: { index: 0, count: 5 } })
  expect(CiHostRequestSchema.safeParse({ ...start, part: 'unit-web-heavy', partition: { index: 1, count: 2 } }).success).toBe(true)
  for (const invalid of [{ ...start, suite: 'build' }, { ...start, part: 'unit-other' }, { ...start, part: undefined }]) {
    expect(CiHostRequestSchema.safeParse(invalid).success).toBe(false)
  }
  expect(CiRunInputSchema.safeParse({ suite: 'unit-api', commandId: 'part' }).success).toBe(false)
})

it('accepts runner selection without caller files or a caller commit for every suite', () => {
  for (const suite of ['unit', 'integration', 'lint', 'typecheck', 'install', 'build']) {
    for (const scope of [undefined, 'affected', 'full']) {
      const request = { suite, commandId: 'runner-selection', ...(scope ? { scope } : {}) }
      expect(CiRunInputSchema.parse(request)).toEqual(request)
      expect(OperatorCiRunInputSchema.parse({ ...request, workspaceId: 'workspace-ci' })).toMatchObject(request)
      expect(CiHostRequestSchema.parse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
        repository: 'example/project', commit: input.commit, defaultBranch: 'release/stable', suite,
        ...(scope ? { scope } : {}) })).toMatchObject({ suite, defaultBranch: 'release/stable' })
    }
  }
  expect(CiRunInputSchema.parse({ ...input, scope: undefined })).toMatchObject({ files: input.files })
})

it('rejects unpinned caller selections, traversal, unsupported selected suites and mixing full scope with selections', () => {
  for (const invalid of [{ ...input, commit: undefined },
    { ...input, files: ['apps/api/../escape.test.ts'] }, { ...input, files: ['apps/api/src/feature.ts'] },
    { ...input, files: ['apps/api/test/feature.integration.test.ts'] }, { ...input, suite: 'build' },
    { ...input, scope: 'full' }]) expect(CiRunInputSchema.safeParse(invalid).success).toBe(false)
  expect(CiRunInputSchema.safeParse({ ...input, files: ['apps/web/src/feature.integration.test.tsx'] }).success).toBe(true)
  expect(CiRunInputSchema.safeParse({ ...input, files: [] }).success).toBe(true)
  expect(CiRunInputSchema.safeParse({ suite: 'unit', scope: 'full', commandId: 'full' }).success).toBe(true)
})

it('accepts safe selected paths from any repository without a file-count limit', () => {
  const files = ['package.json', 'docs/guide.md', '.github/workflows/ci.yml', 'src/feature.test.ts',
    'lib/a file.test.ts', 'docs/راهنما.md', `src/${'a'.repeat(301)}.ts`]
  expect(CiSelectedFilesSchema.parse(files)).toEqual(files)
  const selection = Array.from({ length: 2001 }, (_, index) => `src/feature-${index}.ts`)
  const request = { ...input, suite: 'typecheck', files: selection }
  expect(CiRunInputSchema.parse(request)).toEqual(request)
  expect(OperatorCiRunInputSchema.parse({ ...request, workspaceId: 'workspace-ci' })).toMatchObject(request)
  expect(CiHostRequestSchema.parse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
    repository: 'example/project', suite: request.suite, commit: request.commit,
    scope: request.scope, files: selection })).toMatchObject({ files: selection })
})

it.each(['../escape.ts', 'src/../escape.ts', '/src/file.ts', 'C:/src/file.ts',
  'src\\..\\escape.ts', 'src/./file.ts', 'src//file.ts', 'src/file.ts\0', ''])(
  'rejects unsafe selected paths: %s', file => {
  expect(CiSelectedFilesSchema.safeParse([file]).success).toBe(false)
})
