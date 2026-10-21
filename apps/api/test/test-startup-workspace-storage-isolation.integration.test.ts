import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it(
  'refuses prepared native acceptance when the real API uses an unowned WORKSPACE_STORAGE_ROOT',
  () => rejectsUnownedStartup('WORKSPACE_STORAGE_ROOT'),
  120_000,
)
