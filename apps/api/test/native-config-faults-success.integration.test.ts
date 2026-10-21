import { it } from 'vitest'
import { runNativeConfigFault } from './helpers/nativeConfigFaults.js'

it('preserves native configuration and reconciles none through authenticated MCP', async () => {
  await runNativeConfigFault('none')
}, 240_000)
