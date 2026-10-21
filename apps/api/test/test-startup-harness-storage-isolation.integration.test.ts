import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it(
  'refuses prepared native acceptance when the real API uses an unowned HARNESS_WORKSPACE_ROOT',
  () => rejectsUnownedStartup('HARNESS_WORKSPACE_ROOT'),
  120_000,
)
