import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it(
  'refuses prepared native acceptance when the real API uses an unowned FOREMAN_CODE_APP_MCP_DIRECTORY',
  () => rejectsUnownedStartup('FOREMAN_CODE_APP_MCP_DIRECTORY'),
  120_000,
)
