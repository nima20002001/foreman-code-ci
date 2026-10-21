import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { captureInstalledRuntimeConfigurationRecord, InstalledJobRuntimeConfigurationRecordSchema }
  from '../modules/jobs/installedRuntimeHost.js'
import { InstalledVerificationRuntimeCaptureInputSchema } from '../modules/jobs/installedVerificationConfiguration.js'
import { ignoreError } from '../modules/diagnostics/ignoredError.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const ReviewedRefreshSchema = z.object({
  expectedConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  captureInput: InstalledVerificationRuntimeCaptureInputSchema,
}).strict()

async function writePrivate(path: string, bytes: Uint8Array, exclusive: boolean): Promise<void> {
  const file = await open(path, exclusive ? 'wx' : 'w', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally { await file.close() }
}

/** Main's CI runtime refresh. A separate user unit runs it while Main is stopped (scheduleCiRuntimeRefresh):
 * it captures the next protected configuration of Main's own installation from the reviewed input and keeps
 * the previous one, which accepted Jobs and qualifications still resolve. */
export async function refreshMainJobRuntime(input: { stateDirectory: string; inputPath: string }) {
  const reviewed = ReviewedRefreshSchema.parse(JSON.parse(await readFile(input.inputPath, 'utf8')))
  const output = join(input.stateDirectory, 'job-runtime.json')
  const previousBytes = await readFile(output)
  const digest = sha256(previousBytes)
  if (digest !== reviewed.expectedConfigurationSha256) {
    throw new Error('The protected runtime configuration changed since this refresh was reviewed.')
  }
  const previous = InstalledJobRuntimeConfigurationRecordSchema.parse(JSON.parse(previousBytes.toString('utf8')))
  if (previous.schemaVersion !== 2) throw new Error('Only verification runtimes are refreshed automatically.')
  const { descriptor } = reviewed.captureInput
  if (descriptor.target.hostRef.kind !== 'main' || !isDeepStrictEqual(descriptor.target, previous.descriptor.target)
    || descriptor.runtimeRoot !== input.stateDirectory || descriptor.runtimeRoot !== previous.descriptor.runtimeRoot) {
    throw new Error('A Main refresh must keep this Main installation and its runtime root.')
  }
  const configuration = InstalledJobRuntimeConfigurationRecordSchema.parse(
    await captureInstalledRuntimeConfigurationRecord(reviewed.captureInput))
  const retained = join(input.stateDirectory, `job-runtime-${digest}.json`)
  await writePrivate(retained, previousBytes, true).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST' || sha256(await readFile(retained)) !== digest) throw error
  })
  const temporary = join(input.stateDirectory, `.job-runtime-${randomUUID()}.json`)
  try {
    await writePrivate(temporary, Buffer.from(`${JSON.stringify(configuration)}\n`), true)
    await rename(temporary, output)
  } finally { await unlink(temporary).catch(ignoreError('lifecycle', 'unlink', { module: 'cli/refreshMainJobRuntime' }, ['ENOENT'])) }
  const directory = await open(input.stateDirectory, 'r')
  try { await directory.sync() } finally { await directory.close() }
  return { configurationPath: output, previousConfigurationPath: retained }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { state: { type: 'string' }, input: { type: 'string' } } })
  if (!values.state || !values.input) throw new Error('Usage: refreshMainJobRuntime --state <runtime root> --input <reviewed refresh>')
  console.log(JSON.stringify(await refreshMainJobRuntime({ stateDirectory: values.state, inputPath: values.input })))
}
