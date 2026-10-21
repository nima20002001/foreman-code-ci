// Checks the Worker source graph without bundling or executing imported modules.
//   node scripts/check-worker-imports.mjs [repository-root]
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertWorkerSnapshotSource, rsyncWriterEntrypoint, schemaWorkerEntrypoint,
  workerContractAliases, workerEntryPoints,
} from './worker-snapshot-policy.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repositoryRoot, 'apps/api/package.json'))
const ts = require('typescript')

function typeOnlyImport(clause) {
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const bindings = clause.namedBindings
  return !clause.name && bindings && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
}

function typeOnlyExport(node) {
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  return clause && ts.isNamedExports(clause)
    && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly)
}

function runtimeSpecifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest)
  const specifiers = []
  const visit = node => {
    if (ts.isImportDeclaration(node) && !typeOnlyImport(node.importClause)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !typeOnlyExport(node)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node) && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      // Literal import() and require() are also followed by the artifact bundler.
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

export function checkWorkerImports(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/contracts/package.json'), 'utf8'))
  const aliases = workerContractAliases(manifest.exports)
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true }
  const seen = new Set()
  const pending = [...Object.values(workerEntryPoints), rsyncWriterEntrypoint, schemaWorkerEntrypoint]
    .map(file => [file])
  while (pending.length) {
    const chain = pending.pop()
    const file = chain.at(-1)
    if (seen.has(file)) continue
    seen.add(file)
    try {
      assertWorkerSnapshotSource(file)
    } catch (error) {
      throw new Error(`${error.message}\nImport chain: ${chain.join(' -> ')}`, { cause: error })
    }
    if (file.endsWith('.json')) continue
    const text = readFileSync(join(root, file), 'utf8')
    for (const specifier of runtimeSpecifiers(file, text)) {
      if (Object.hasOwn(aliases, specifier)) {
        pending.push([...chain, relative(root, resolve(root, aliases[specifier])).replaceAll('\\', '/')])
        continue
      }
      // Third-party packages and Node builtins are outside the repository snapshot.
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue
      const target = ts.resolveModuleName(specifier, join(root, file), options, ts.sys).resolvedModule
      if (!target) throw new Error(`Cannot resolve Worker import ${specifier} from ${file}`)
      // TypeScript prefers a sibling declaration (x.d.mts) for x.mjs; the bundler loads the JavaScript itself.
      const runtime = target.resolvedFileName.replace(/\.d\.(m|c)?ts$/, (_, kind) => `.${kind ?? ''}js`)
      pending.push([...chain, relative(root, ts.sys.fileExists(runtime) ? runtime : target.resolvedFileName).replaceAll('\\', '/')])
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    checkWorkerImports(resolve(process.argv[2] ?? repositoryRoot))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
