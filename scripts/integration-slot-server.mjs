// One integration slot's Vitest coordinator, reused for consecutive ordinary files. Every file still gets a fresh
// worker process (isolate: true), so modules never leak between files; only coordinator startup, config, the Vite
// server and global setup are paid once per slot. The runner writes one JSON command per line to stdin and reads
// the file's exit status from the done line this process prints after the file's output.
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const slotDonePrefix = '[integration-slot] done '

const api = fileURLToPath(new URL('../apps/api/', import.meta.url))

/** Mirrors the Vitest CLI's exit status for one file: a failed or missing module or an unhandled error fails it. */
export function slotFileCode(testModule, unhandledErrors) {
  return testModule && testModule.state() !== 'failed' && !unhandledErrors.length ? 0 : 1
}

function useEnvironment(environment) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment, { TEST: 'true', VITEST: 'true' })
  process.env.NODE_ENV ??= 'test'
}

async function main() {
  const { reporter, testNamePattern } = JSON.parse(process.argv[2])
  const { createVitest } = await import(pathToFileURL(createRequire(join(api, 'package.json')).resolve('vitest/node')).href)
  // Keep one ordered stream, so the done line follows everything the file wrote.
  process.stderr.write = process.stdout.write.bind(process.stdout)
  let vitest
  let broken = false
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const { file, json, environment } = JSON.parse(line)
    useEnvironment(environment)
    let code = 1
    try {
      if (!vitest) {
        vitest = await createVitest({ watch: false, fileParallelism: false, maxWorkers: 1, maxConcurrency: 1,
          reporters: ['verbose', 'json', reporter], outputFile: { json }, fsModuleCache: true,
          ...(testNamePattern ? { testNamePattern } : {}) })
        // Initializes reporters as `vitest run` does before its first run.
        await vitest.standalone()
      }
      vitest.config.outputFile = { json }
      const moduleId = resolve(api, file.slice('apps/api/'.length))
      const specifications = (await vitest.globTestSpecifications([moduleId]))
        .filter((specification) => specification.moduleId === moduleId)
      if (specifications.length !== 1) throw new Error(`Expected one Vitest specification for ${file}`)
      const { unhandledErrors } = await vitest.runTestSpecifications(specifications)
      code = slotFileCode(specifications[0].testModule, unhandledErrors)
    } catch (error) {
      // A coordinator that failed outside a test may be inconsistent; the runner starts a fresh one.
      broken = true
      console.error(error)
    }
    await new Promise((done) => process.stdout.write(`\n${slotDonePrefix}${code}\n`, done))
    if (broken) break
  }
  await vitest?.close()
  process.exit(broken ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exit(1) })
}
