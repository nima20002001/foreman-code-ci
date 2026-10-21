// Checks that a release commit ships only code that passed one clean full round through Foreman CI:
//   node scripts/verify-release-round.mjs <release commit>
// The deploy watcher must call this before it deploys a 'Release vX.Y.Z' commit and skip the release when it exits
// non-zero. A release commit (written by scripts/release.mjs) changes only the version in package.json and
// CHANGELOG.md on top of its parent, and records the round in 'Clean-Round: gate=<ticket ids>' (one gate group covering
// typecheck, lint, unit and integration) or older 'Clean-Round: <suite>=<ticket ids>' trailers. Every recorded group
// must have run on the parent commit with full scope. A failed gate part can be replaced with a passed same-file,
// same-suite ticket (or that ticket's partitions together) on that code commit or a descendant, recorded as
// 'Clean-Round-Rerun: <failed>=<replacement>'.
// Main is reached like scripts/ci-remote.mjs: FOREMAN_CODE_MAIN_URL, FOREMAN_CODE_OPERATOR_TOKEN(_FILE) and
// optionally FOREMAN_CODE_WORKSPACE_ID.
import { execFileSync, spawnSync } from 'node:child_process'
import { mcpClient, workspaceFor } from './ci-remote.mjs'

export const RELEASE_SUITES = ['typecheck', 'lint', 'unit', 'integration']

/** The one commandId for gating a commit, shared by releases and the gate line so a passed gate is reused. */
export const gateCommandId = commit => `gate-${commit}`

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Explicit substitutions for gate parts the owner identified as infrastructure failures. */
export function parseReruns(values) {
  const reruns = new Map()
  for (const value of values) {
    if (!/^[^\s=,]+=[^\s=,]+$/.test(value ?? '')) {
      throw new Error('A rerun must be <failedTicket>=<replacementTicket>.')
    }
    const [failed, replacement] = value.split('=')
    if (reruns.has(failed)) throw new Error(`More than one rerun is recorded for ticket ${failed}.`)
    reruns.set(failed, replacement)
  }
  return reruns
}

/** Problems that keep the release commit from deploying; empty when its clean round is verified. */
export async function releaseRoundProblems(call, workspaceId, commit, cwd = process.cwd()) {
  const parent = git(['rev-parse', `${commit}^`], cwd)
  const problems = []
  const changed = git(['diff', '--name-only', parent, commit], cwd).split('\n').filter(Boolean)
  const extra = changed.filter(file => file !== 'package.json' && file !== 'CHANGELOG.md')
  if (extra.length) problems.push(`The release commit changes code beyond the version and changelog: ${extra.join(', ')}`)
  if (changed.includes('package.json')) {
    const manifest = revision => ({ ...JSON.parse(git(['show', `${revision}:package.json`], cwd)), version: undefined })
    if (JSON.stringify(manifest(parent)) !== JSON.stringify(manifest(commit))) problems.push('The release commit changes package.json beyond its version.')
  }
  const recorded = new Map(git(['log', '-1', '--format=%(trailers:key=Clean-Round,valueonly,separator=%x0a)', commit], cwd)
    .split('\n').filter(Boolean).map(value => {
      const [suite, ids = ''] = value.split('=')
      return [suite.trim(), ids.split(',').map(id => id.trim()).filter(Boolean)]
    }))
  const rerunValues = git(['log', '-1', '--format=%(trailers:key=Clean-Round-Rerun,separator=%x0a)', commit], cwd)
    .split('\n').filter(Boolean).map(line => line.slice(line.indexOf(':') + 1).trim())
  let reruns
  try {
    reruns = parseReruns(rerunValues)
  } catch (error) {
    problems.push(error.message)
    return problems
  }
  if (recorded.has('gate')) {
    problems.push(...await gateRoundProblems(call, workspaceId, recorded.get('gate'), parent, { reruns, cwd }))
    return problems
  }
  if (reruns.size) problems.push('Clean-Round-Rerun requires a recorded gate round.')
  for (const suite of RELEASE_SUITES) {
    const tickets = recorded.get(suite) ?? []
    if (!tickets.length) { problems.push(`No clean ${suite} round is recorded.`); continue }
    const found = await call('ci_get', { workspaceId, ticketId: tickets[0] }).catch(error => ({ error }))
    if (found.error) { problems.push(`${suite} ticket ${tickets[0]} is unreadable: ${found.error.message}`); continue }
    const group = found.partitions ?? [found.run]
    const ids = group.map(run => run.id)
    if (ids.length !== tickets.length || ids.some(id => !tickets.includes(id))) {
      problems.push(`${suite}: the recorded tickets are not the whole CI group (${ids.join(', ')}).`)
    }
    for (const run of group) {
      const label = `${suite} ticket ${run.id}`
      if (run.suite !== suite) problems.push(`${label} ran the ${run.suite} suite.`)
      if (run.scope !== 'full') problems.push(`${label} ran with ${run.scope} scope, not full.`)
      if (run.commit !== parent) problems.push(`${label} tested ${run.commit}, not the released code ${parent}.`)
      if (run.state !== 'passed') problems.push(`${label} ${run.state}.`)
    }
  }
  return problems
}

/** A full gate covers every release suite; each part passed or has a validated explicit rerun. */
export async function gateRoundProblems(call, workspaceId, tickets, parent, { reruns = new Map(), cwd = process.cwd() } = {}) {
  if (!tickets.length) return ['No clean gate round is recorded.']
  const found = await call('ci_get', { workspaceId, ticketId: tickets[0] }).catch(error => ({ error }))
  if (found.error) return [`gate ticket ${tickets[0]} is unreadable: ${found.error.message}`]
  const problems = []
  const group = found.partitions ?? [found.run]
  const ids = group.map(run => run.id)
  if (ids.length !== tickets.length || ids.some(id => !tickets.includes(id))) {
    problems.push(`gate: the recorded tickets are not the whole CI group (${ids.join(', ')}).`)
  }
  for (const failed of reruns.keys()) {
    if (!ids.includes(failed)) problems.push(`Rerun ticket ${failed} is not in the gate group.`)
  }
  for (const run of group) {
    const label = `gate ${run.suite} ticket ${run.id}`
    if (run.gate !== true) problems.push(`${label} is not a gate run.`)
    if (run.scope !== 'full') problems.push(`${label} ran with ${run.scope} scope, not full.`)
    if (run.commit !== parent) problems.push(`${label} tested ${run.commit}, not the released code ${parent}.`)
    const replacement = reruns.get(run.id)
    if (replacement) {
      if (run.state !== 'failed') problems.push(`${label} ${run.state}, not failed; it cannot be replaced.`)
      problems.push(...await rerunProblems(call, workspaceId, run, replacement, parent, cwd))
    } else if (run.state !== 'passed') {
      problems.push(`${label} ${run.state}.`)
    }
  }
  for (const suite of RELEASE_SUITES) {
    if (!group.some(run => run.suite === suite)) problems.push(`The gate round has no ${suite} part.`)
  }
  return problems
}

async function rerunProblems(call, workspaceId, failed, ticketId, parent, cwd) {
  const found = await call('ci_get', { workspaceId, ticketId }).catch(error => ({ error }))
  if (found.error) return [`Rerun ticket ${ticketId} is unreadable: ${found.error.message}`]
  const replacement = found.run
  // The named ticket replaces the failed part on its own when it ran exactly those files. An affected rerun split
  // across computers otherwise replaces it with all of its partitions together.
  const parts = sameFiles(failed, [replacement]) ? [replacement] : found.partitions ?? [replacement]
  const problems = []
  const label = `Rerun ticket ${ticketId} for ${failed.id}`
  if (replacement.id !== ticketId) problems.push(`${label} returned a different ticket.`)
  for (const part of parts) {
    const partLabel = part.id === ticketId ? label : `${label} partition ${part.id}`
    if (part.state !== 'passed') problems.push(`${partLabel} ${part.state}.`)
    if (part.suite !== failed.suite) problems.push(`${partLabel} ran ${part.suite}, not ${failed.suite}.`)
    if (!isDescendant(parent, part.commit, cwd)) {
      problems.push(`${partLabel} tested ${part.commit}, not the released code ${parent} or a descendant.`)
    }
  }
  if (!sameFiles(failed, parts)) problems.push(`${label} did not select exactly the failed part's files.`)
  return problems
}

function sameFiles(failed, parts) {
  if (!Array.isArray(failed.files) || failed.deriveFiles === true
    || !parts.every(part => Array.isArray(part.files) && part.deriveFiles !== true)) return false
  const original = [...failed.files].sort()
  const replacement = parts.flatMap(part => part.files).sort()
  return original.length === replacement.length && original.every((file, index) => file === replacement[index])
}

function isDescendant(parent, commit, cwd) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit ?? '')) return false
  const result = spawnSync('git', ['merge-base', '--is-ancestor', parent, commit], { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  return result.status === 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [commit] = process.argv.slice(2)
  if (!commit) {
    console.error('usage: node scripts/verify-release-round.mjs <release commit>')
    process.exit(2)
  }
  process.exitCode = await (async () => {
    const call = await mcpClient('verify-release-round')
    const problems = await releaseRoundProblems(call, await workspaceFor(call), git(['rev-parse', commit]))
    for (const problem of problems) console.error(`[release] ${problem}`)
    if (problems.length) { console.error(`[release] ${commit} has no clean round; do not deploy it.`); return 1 }
    console.error(`[release] ${commit} ships code that passed one clean full round.`)
    return 0
  })().catch(error => { console.error(`[release] ${error.message}`); return 1 })
}
