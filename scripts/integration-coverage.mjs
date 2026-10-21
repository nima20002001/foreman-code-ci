import { Session } from 'node:inspector'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Function-level V8 coverage avoids counters for every statement and source-map/HTML reporting. */
export async function startFileCoverage() {
  const session = new Session()
  session.connect()
  const post = (method, params) => new Promise((done, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : done(result))
  })
  await post('Profiler.enable')
  await post('Profiler.startPreciseCoverage', { callCount: false, detailed: false })
  const stop = async (root, tracked) => {
    try {
      const { result } = await post('Profiler.takePreciseCoverage')
      stop.requiresStatic = result.some(script => /^node:(?:internal\/)?(?:child_process|worker)/.test(script.url)
        && script.functions.some(fn => /^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Worker)$/.test(fn.functionName)
          && fn.ranges.some(range => range.count > 0)))
      await post('Profiler.stopPreciseCoverage')
      return executedRepositoryFiles(result, root, tracked)
    } finally {
      session.disconnect()
    }
  }
  return stop
}

export function executedRepositoryFiles(scripts, root, tracked) {
  const files = new Set()
  for (const script of scripts) {
    if (!script.url.startsWith('file:') || !script.functions.some(fn => fn.ranges.some(range => range.count > 0))) continue
    let file = relative(root, fileURLToPath(script.url.split('?')[0])).replaceAll('\\', '/')
    // Contracts execute their built modules; selection compares the corresponding repository sources.
    file = file.replace(/^packages\/contracts\/dist\//, 'packages/contracts/src/')
    const stem = file.replace(/\.[cm]?js$/, '')
    const candidate = [file, `${stem}.ts`, `${stem}.mts`, `${stem}.tsx`].find(path => tracked.has(path))
    if (candidate) files.add(candidate)
  }
  return [...files].sort()
}

/** Each worker writes once; the parent publishes only reports from successful, complete first attempts. */
export function integrationCoverageReport(directory, commit, testFiles, completed) {
  const coverage = {}
  const staticTests = []
  for (const file of completed) {
    const path = resolve(directory, `${file.slice('apps/api/test/'.length)}.json`)
    if (existsSync(path)) {
      const report = JSON.parse(readFileSync(path, 'utf8'))
      coverage[file] = report.files
      if (report.requiresStatic) staticTests.push(file)
    } else {
      coverage[file] = []
      staticTests.push(file)
    }
  }
  return { version: 1, commit, testFiles, coverage, staticTests }
}

export function writeFileCoverage(directory, file, files, requiresStatic) {
  writeFileSync(resolve(directory, `${file.slice('apps/api/test/'.length)}.json`), JSON.stringify({ files, requiresStatic }))
}
