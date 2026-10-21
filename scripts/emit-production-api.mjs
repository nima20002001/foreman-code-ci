import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function readEmitCache(path, signature) {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8'))
    if (cache.signature !== signature) return {}
    if (!cache.files || typeof cache.files !== 'object' || Array.isArray(cache.files)) {
      throw new Error('API emit cache entries are invalid')
    }
    return cache.files
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`API emit cache unavailable: ${error.message}`)
    return {}
  }
}

async function outputMatches(output, record, sourceSha256, sourceMap) {
  if (!record || record.sourceSha256 !== sourceSha256) return false
  try {
    if (sha256(await readFile(output)) !== record.outputSha256) return false
    return !sourceMap || sha256(await readFile(`${output}.map`)) === record.mapSha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function assertValid(ts, diagnostics) {
  const errors = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (!errors.length) return
  throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }))
}

// The parallel tsc --noEmit --isolatedModules check must pass before this output can be activated.
export async function emitProductionApi(repository) {
  const api = join(repository, 'apps/api')
  const require = createRequire(join(api, 'package.json'))
  const ts = require('typescript')
  const signatureHash = createHash('sha256').update(ts.version).update(await readFile(fileURLToPath(import.meta.url)))
  const readConfig = path => {
    const contents = ts.sys.readFile(path)
    if (contents !== undefined) signatureHash.update(path).update('\0').update(contents).update('\0')
    return contents
  }
  const configPath = join(api, 'tsconfig.build.json')
  const config = ts.readConfigFile(configPath, readConfig)
  assertValid(ts, config.error ? [config.error] : [])
  const parsed = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, readFile: readConfig }, api, undefined, configPath)
  assertValid(ts, parsed.errors)
  const compilerOptions = { ...parsed.options, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: false, declaration: false,
    declarationMap: false, incremental: false, composite: false }
  const signature = signatureHash.digest('hex')
  const cachePath = join(api, 'node_modules/.cache/production-emit.json')
  const cached = await readEmitCache(cachePath, signature)
  const files = {}
  let emitted = 0
  for (const source of parsed.fileNames) {
    if (/\.d\.[cm]?ts$/.test(source)) continue
    const output = join(parsed.options.outDir, relative(parsed.options.rootDir, source).replace(/\.ts$/, '.js'))
    const key = relative(api, source)
    const contents = await readFile(source, 'utf8')
    const sourceSha256 = sha256(contents)
    if (await outputMatches(output, cached[key], sourceSha256, compilerOptions.sourceMap)) {
      files[key] = cached[key]
      continue
    }
    const result = ts.transpileModule(contents, {
      compilerOptions, fileName: source, reportDiagnostics: true,
    })
    assertValid(ts, result.diagnostics ?? [])
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, result.outputText)
    const record = { sourceSha256, outputSha256: sha256(result.outputText) }
    if (result.sourceMapText) {
      const map = JSON.parse(result.sourceMapText)
      map.file = basename(output)
      map.sources = [relative(dirname(output), source)]
      const mapText = JSON.stringify(map)
      await writeFile(`${output}.map`, mapText)
      record.mapSha256 = sha256(mapText)
    }
    files[key] = record
    emitted++
  }
  await mkdir(dirname(cachePath), { recursive: true })
  const temporary = `${cachePath}.${process.pid}`
  await writeFile(temporary, JSON.stringify({ signature, files }))
  await rename(temporary, cachePath)
  return emitted
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const started = performance.now()
  const files = await emitProductionApi(fileURLToPath(new URL('../', import.meta.url)))
  console.log(JSON.stringify({ operation: 'emit production API', files, elapsedMs: Math.round(performance.now() - started) }))
}
