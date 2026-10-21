import { expect, it } from 'vitest'
import { onlyCiInfrastructure } from './priority.js'

it.each([
  ['apps/api/src/modules/ci-host/service.ts'],
  ['apps/api/src/modules/jobs/ciRuntimeWorker.ts', 'apps/api/src/modules/jobs/dispatch.ts'],
  ['scripts/ci-affected.mjs', 'scripts/test-db.mjs', 'scripts/test-integration.mjs'],
  ['.github/workflows/ci.yml', '.circleci/config.yml'],
].map(files => ({ files })))('recognizes CI-only changes: $files', ({ files }) => {
  expect(onlyCiInfrastructure(files)).toBe(true)
})

it.each([
  [],
  ['apps/api/src/modules/ci-host/service.ts', 'apps/web/src/App.tsx'],
  ['apps/api/src/modules/jobs/service.ts'],
  ['scripts/ci-directory/product.mjs'],
  ['.github/workflows/release.yml'],
].map(files => ({ files })))('keeps empty, mixed and unrelated changes normal: $files', ({ files }) => {
  expect(onlyCiInfrastructure(files)).toBe(false)
})
