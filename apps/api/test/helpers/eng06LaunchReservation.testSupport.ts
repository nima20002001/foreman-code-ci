import { execFileSync } from 'node:child_process'
import type { NativeProcessRecovery } from '../../src/modules/harnesses/recovery/processRegistry.js'

/** Real write-ahead registry IO in a short-lived OS process. Returning means
 * that exact parent is gone; there is no provider process or fabricated close.
 * Engine tests use this only at the external-process boundary, while all SQL
 * native-entry, closure, source and graph receipts are written by production. */
export function reserveFromExitedParent(root: string, owner: string): NativeProcessRecovery {
  const source = new URL('../../src/modules/harnesses/recovery/processRegistry.ts', import.meta.url).href
  const script = `import { NativeProcessRegistry } from ${JSON.stringify(source)};
    console.log(JSON.stringify(await new NativeProcessRegistry(${JSON.stringify(root)}).reserveLaunch(${JSON.stringify(owner)})));`
  const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
  const scope = JSON.parse(output.trim()) as NativeProcessRecovery
  if (scope.root !== root || scope.owner !== owner || !scope.launchId) throw new Error('The child did not reserve the exact native launch')
  return scope
}
