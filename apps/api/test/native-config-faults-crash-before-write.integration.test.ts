import { it } from 'vitest'
import { runNativeConfigFault } from './helpers/nativeConfigFaults.js'

it('preserves native configuration and reconciles crash-before-write through authenticated MCP', async () => {
  await runNativeConfigFault('crash-before-write')
}, 240_000)
