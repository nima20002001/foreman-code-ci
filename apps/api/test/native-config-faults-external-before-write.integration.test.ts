import { it } from 'vitest'
import { runNativeConfigFault } from './helpers/nativeConfigFaults.js'

it('preserves native configuration and reconciles external-before-write through authenticated MCP', async () => {
  await runNativeConfigFault('external-before-write')
}, 240_000)
