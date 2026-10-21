import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CodexNativeOutputSandbox } from '../../codexNativeOutput.js'
import type { NativeQualificationSuiteInput } from '../nativeOwnership.js'
import { collectChecks, requireCondition, type Check } from './checks.js'
import { z } from 'zod'

export const CODEX_NATIVE_OUTPUT_SANDBOX_SUITE_REVISION = 'codex-native-output-protection-3'
export interface CodexNativeSandboxProbeObservation {
  /** Actual qualified command item from the original diagnostic session/turn, not assistant text. */
  nativeSessionId: string; nativeTurnId: string; itemId: string
  command: string; status: string; exitCode: number | null; aggregatedOutput: string
}
export interface CodexNativeSandboxProbePort {
  /** Root composes exact owned diagnostic binary/schema/connection/generation fences. */
  assertCurrent(signal: AbortSignal): Promise<void>
  capturePolicy(signal: AbortSignal, command: string): Promise<{
    binarySha256: string; providerVersion: string; schemaIdentity: string
    nativeSessionId: string; nativeTurnId: string
    nativeShell: string
    sandboxType: string; effectiveSandbox: CodexNativeOutputSandbox
  }>
  executeExactCommand(command: string, signal: AbortSignal): Promise<CodexNativeSandboxProbeObservation>
}
const contains = (root: string, target: string) => {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
export function assertCodexProtectedOutputPlacement(root: string, sandbox: CodexNativeOutputSandbox): void {
  requireCondition(isAbsolute(root) && isAbsolute(sandbox.cwd) && sandbox.writableRoots.every(isAbsolute), 'Native sandbox roots must be absolute.')
  const writable = [sandbox.cwd, ...sandbox.writableRoots,
    ...(!sandbox.excludeSlashTmp ? ['/tmp'] : []),
    ...(!sandbox.excludeTmpdirEnvVar && sandbox.tmpdir ? [sandbox.tmpdir] : [])]
  requireCondition(writable.every(isAbsolute), 'Actual native writable roots and TMPDIR must be absolute.')
  requireCondition(writable.every(path => !contains(path, root) && !contains(root, path)), 'Protected output store overlaps actual native writable roots or TMPDIR.')
}
export function codexNativeOutputSandboxProbeProgram(input: {
  directPath: string; descendantPath: string; witnessPath: string; marker: string
}): string {
  const script = `import errno,json,os,subprocess,sys\ndef attempt(p):\n try:\n  with open(p,'x') as f: f.write(${JSON.stringify(input.marker)})\n  return {'denied':False,'errno':None}\n except OSError as e: return {'denied':e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),'errno':e.errno}\ndirect=attempt(${JSON.stringify(input.directPath)})\nchild="import errno,json,sys\\ntry:\\n with open(sys.argv[1],'x') as f: f.write(sys.argv[2])\\n print(json.dumps({'denied':False,'errno':None}))\\nexcept OSError as e: print(json.dumps({'denied':e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),'errno':e.errno}))"\nresult=subprocess.run([sys.executable,'-c',child,${JSON.stringify(input.descendantPath)},${JSON.stringify(input.marker)}],capture_output=True,text=True)\nproof={'marker':${JSON.stringify(input.marker)},'uid':os.getuid(),'tmpdir':os.environ.get('TMPDIR'),'direct':direct,'descendant':json.loads(result.stdout),'descendantExitCode':result.returncode}\nwith open(${JSON.stringify(input.witnessPath)},'x') as f: json.dump(proof,f)\nprint(json.dumps(proof))`
  return script
}
export function codexNativeOutputSandboxProbeCommand(programPath: string): string {
  return `/usr/bin/python3 '${programPath.replaceAll("'", "'\\''")}'`
}

/** Command items include the selected shell's argv display; the script payload stays exact. */
export function matchesCodexNativeProbeCommand(observed: unknown, expected: string, shell: string): boolean {
  if (observed === expected) return true
  if (!isAbsolute(shell) || /[\s'"\\$`]/u.test(shell)) return false
  const singleQuoted = `'${expected.replaceAll("'", "'\\''")}'`
  const doubleQuoted = `"${expected.replace(/[\\"$`]/gu, '\\$&')}"`
  return [singleQuoted, doubleQuoted].some(argument =>
    observed === `${shell} -lc ${argument}` || observed === `${shell} -c ${argument}`)
}
const writeAttemptSchema = z.object({ denied: z.boolean(), errno: z.number().int().nullable() }).strict()
const probeResultSchema = z.object({ marker: z.string(), uid: z.number().int().nonnegative(),
  tmpdir: z.string().nullable(), direct: writeAttemptSchema, descendant: writeAttemptSchema,
  descendantExitCode: z.number().int() }).strict()

/** Native command output combines stdout and stderr; only one nonce-bound probe record is evidence. */
export function parseCodexNativeProbeOutput(output: unknown, marker: string) {
  if (typeof output !== 'string') return undefined
  const records: Array<z.infer<typeof probeResultSchema>> = []
  for (const line of output.split('\n')) {
    let value: unknown
    try { value = JSON.parse(line) }
    catch (error) { if (error instanceof SyntaxError) continue; throw error }
    const parsed = probeResultSchema.safeParse(value)
    if (parsed.success && parsed.data.marker === marker) records.push(parsed.data)
  }
  return records.length === 1 ? records[0] : undefined
}
const missing = async (path: string) => {
  try { await access(path); return false } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true
    throw error
  }
}
/** Definitions/checks only until Root supplies the original owned live probe port.
 * This does not mount a capability or create a trust record; no default/mocked
 * production probe exists. Actual security settings are never rewritten. */
export async function runCodexNativeOutputSandboxChecks(input: NativeQualificationSuiteInput & {
  protectedDirectory: string; schemaIdentity: string; probe: CodexNativeSandboxProbePort
}) {
  const signal = input.signal
  const marker = randomUUID()
  const directPath = join(input.protectedDirectory, `.native-direct-${marker}`)
  const descendantPath = join(input.protectedDirectory, `.native-descendant-${marker}`)
  const witnessPath = join(input.workDirectory, `.native-witness-${marker}.json`)
  const hostPath = join(input.protectedDirectory, `.host-witness-${marker}`)
  const programPath = join(input.protectedDirectory, `.native-probe-${marker}.py`)
  const command = codexNativeOutputSandboxProbeCommand(programPath)
  const evidence: Record<string, unknown> = { revision: CODEX_NATIVE_OUTPUT_SANDBOX_SUITE_REVISION,
    binarySha256: input.binarySha256, providerVersion: input.version, protectedDirectory: input.protectedDirectory }
  const assertCurrent = async () => {
    signal.throwIfAborted(); await input.assertInstallation?.(signal); await input.probe.assertCurrent(signal); signal.throwIfAborted()
    requireCondition(createHash('sha256').update(await readFile(input.binary)).digest('hex') === input.binarySha256, 'Exact native binary changed.')
    signal.throwIfAborted()
  }
  let policy: Awaited<ReturnType<CodexNativeSandboxProbePort['capturePolicy']>> | undefined
  const checks: Check[] = [
    ['exact-binary-policy-and-placement', async () => {
      await assertCurrent()
      requireCondition(await realpath(input.protectedDirectory) === input.protectedDirectory
        && await realpath(input.workDirectory) === input.workDirectory, 'Qualification roots must be canonical.')
      const captured = await input.probe.capturePolicy(signal, command); await assertCurrent()
      requireCondition(captured.binarySha256 === input.binarySha256 && captured.providerVersion === input.version
        && /^[a-f0-9]{64}$/.test(input.schemaIdentity) && captured.schemaIdentity === input.schemaIdentity
        && captured.nativeSessionId && captured.nativeTurnId && isAbsolute(captured.nativeShell)
        && captured.sandboxType === 'workspaceWrite', 'Native policy does not match exact qualified binary/schema/workspace-write.')
      requireCondition(captured.effectiveSandbox.cwd === input.workDirectory, 'Actual native cwd changed.')
      assertCodexProtectedOutputPlacement(input.protectedDirectory, captured.effectiveSandbox)
      for (const root of captured.effectiveSandbox.writableRoots) requireCondition(await realpath(root) === root, 'Actual writable root is not canonical.')
      if (!captured.effectiveSandbox.excludeTmpdirEnvVar && captured.effectiveSandbox.tmpdir) {
        requireCondition(await realpath(captured.effectiveSandbox.tmpdir) === captured.effectiveSandbox.tmpdir, 'Actual writable TMPDIR is not canonical.')
      }
      evidence.effectiveSandbox = structuredClone(captured.effectiveSandbox)
      evidence.schemaIdentity = captured.schemaIdentity
      evidence.nativeShell = captured.nativeShell
      // Show host write succeeds with the same UID; chmod/private ownership alone is no sandbox proof.
      await writeFile(hostPath, marker, { flag: 'wx', mode: 0o600 }); await unlink(hostPath)
      await assertCurrent()
      policy = captured
      return 'Actual native writable roots/TMPDIR exclude the canonical host-writable protected store.'
    }],
    ['native-and-descendant-protected-store-write-denied', async () => {
      requireCondition(policy, 'Actual native policy check did not complete.')
      await assertCurrent()
      const program = codexNativeOutputSandboxProbeProgram({ directPath, descendantPath, witnessPath, marker })
      await writeFile(programPath, program, { flag: 'wx', mode: 0o400 })
      requireCondition(await readFile(programPath, 'utf8') === program, 'The protected probe program changed.')
      const observed = await input.probe.executeExactCommand(command, signal)
      await assertCurrent()
      requireCondition(await readFile(programPath, 'utf8') === program, 'The protected probe program changed.')
      requireCondition(matchesCodexNativeProbeCommand(observed.command, command, policy.nativeShell)
        && observed.status === 'completed' && observed.exitCode === 0
        && observed.nativeSessionId === policy.nativeSessionId && observed.nativeTurnId === policy.nativeTurnId
        && observed.itemId, 'No exact original completed native command item was observed.')
      const result = parseCodexNativeProbeOutput(observed.aggregatedOutput, marker)
      requireCondition(result, 'No unique original native probe result was observed.')
      const witness = JSON.parse(await readFile(witnessPath, 'utf8')) as Record<string, unknown>
      requireCondition(JSON.stringify(result) === JSON.stringify(witness) && result.marker === marker
        && result.uid === process.getuid?.() && (result.tmpdir === null
          || typeof result.tmpdir === 'string' && isAbsolute(result.tmpdir)), 'Native witness or actual descendant environment is malformed.')
      // Measure the command actor's environment instead of inferring it from the app-server.
      assertCodexProtectedOutputPlacement(input.protectedDirectory, { ...policy.effectiveSandbox,
        tmpdir: typeof result.tmpdir === 'string' ? result.tmpdir : undefined })
      const direct = result.direct, descendant = result.descendant
      requireCondition(direct?.denied === true && descendant?.denied === true && result.descendantExitCode === 0
        && await missing(directPath) && await missing(descendantPath), 'Native/descendant wrote the protected store or denial was not evidenced.')
      await assertCurrent()
      evidence.native = { sessionId: observed.nativeSessionId, turnId: observed.nativeTurnId, itemId: observed.itemId }
      evidence.observedTmpdir = result.tmpdir; evidence.directErrno = direct.errno; evidence.descendantErrno = descendant.errno
      return 'Exact native command and its real subprocess were denied protected-store writes; permitted-root witness read back.'
    }],
  ]
  try { return await collectChecks(input, checks, evidence) }
  finally {
    // Root must quiesce the original diagnostic actor before retiring these own markers.
    // This module cannot assert a native process stopped, so no target cleanup or
    // protected-store capability/qualification is inferred from return alone.
    evidence.cleanupPaths = [hostPath, directPath, descendantPath, witnessPath, programPath]
  }
}
