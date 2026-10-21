import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export async function compileApiFixture(directory: string): Promise<string> {
  const repository = fileURLToPath(new URL('../../../../', import.meta.url))
  const api = join(repository, 'apps/api')
  const fixture = join(directory, 'compiled-api')
  const output = join(fixture, 'dist')
  await mkdir(fixture, { recursive: true })
  await cp(join(api, 'package.json'), join(fixture, 'package.json'))
  await symlink(join(api, 'node_modules'), join(fixture, 'node_modules'), 'dir')
  await emitTypeScriptFixture(join(api, 'tsconfig.build.json'), output)
  const runtimeScript = pathToFileURL(join(repository, 'scripts/copy-api-runtime.mjs')).href
  const { copyApiRuntime } = await import(runtimeScript)
  await copyApiRuntime(repository, output)
  return output
}

export async function emitTypeScriptFixture(config: string, output: string): Promise<void> {
  const loaded = ts.readConfigFile(config, ts.sys.readFile)
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(config), {}, config)
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  }
  // Runtime fixtures need JavaScript, not a second copy of the repository's type graph.
  for (const file of parsed.fileNames) {
    if (file.endsWith('.d.ts') || file.endsWith('.d.mts')) continue
    const emitted = ts.transpileModule(await readFile(file, 'utf8'), {
      fileName: file,
      // The API package uses ESM; isolated transforms cannot infer its package.json mode.
      compilerOptions: { ...parsed.options, declaration: false,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
      reportDiagnostics: true,
    })
    const errors = emitted.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
    if (errors.length) {
      throw new Error(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
    }
    const destination = join(output, relative(parsed.options.rootDir ?? dirname(config), file).replace(/\.ts$/u, '.js'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, emitted.outputText)
    if (emitted.sourceMapText) {
      const map = JSON.parse(emitted.sourceMapText) as { sources: string[] }
      map.sources = [relative(dirname(destination), file)]
      await writeFile(`${destination}.map`, JSON.stringify(map))
    }
  }
}
