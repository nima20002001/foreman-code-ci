import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it(
  'refuses prepared native acceptance when the real API uses an unowned FILE_STORAGE_ROOT',
  () => rejectsUnownedStartup('FILE_STORAGE_ROOT'),
  120_000,
)
