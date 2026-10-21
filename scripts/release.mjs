// Releases main after one clean full round through Foreman CI:
//   corepack pnpm release <X.Y.Z> [--notes-file <file>] [--gate-ticket <ticket>] [--rerun <failed>=<replacement>]...
// Requires a clean main equal to origin/main. Gates HEAD on Main's CI (typecheck, lint, unit and integration, full
// scope; see scripts/ci-remote.mjs for the connection settings), reusing the gate that already ran on HEAD, and waits
// for every part. With --gate-ticket, explicit --rerun substitutions identify infrastructure failures and must pass
// the verifier's same-suite, same-files and commit ancestry checks. Any unreplaced failure stops the release. It writes the
// 'Release vX.Y.Z' commit (package.json version and a CHANGELOG.md entry from --notes-file or the Unreleased section)
// with 'Clean-Round: gate=<ticket ids>' and any 'Clean-Round-Rerun: <failed>=<replacement>' trailers, verifies and pushes it.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { awaitTickets, mcpClient, workspaceFor } from './ci-remote.mjs'
import { gateCommandId, gateRoundProblems, parseReruns, releaseRoundProblems } from './verify-release-round.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function release(version, notesFile, gateTicket, rerunValues) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error('usage: corepack pnpm release <X.Y.Z> [--notes-file <file>] [--gate-ticket <id>] [--rerun <failed>=<replacement>]...')
  }
  const reruns = parseReruns(rerunValues)
  if (reruns.size && !gateTicket) throw new Error('--rerun requires --gate-ticket.')
  if (git('branch', '--show-current') !== 'main') throw new Error('Releases are made from main.')
  if (git('status', '--porcelain')) throw new Error('The worktree has uncommitted changes.')
  git('fetch', '--quiet', 'origin', 'main')
  const commit = git('rev-parse', 'HEAD')
  if (commit !== git('rev-parse', 'origin/main')) throw new Error('main is not equal to origin/main.')
  const manifest = readFileSync('package.json', 'utf8')
  if (JSON.parse(manifest).version === version) throw new Error(`package.json already has version ${version}.`)
  const changelog = readFileSync('CHANGELOG.md', 'utf8')
  const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/.exec(changelog)
  if (!unreleased) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.')
  const notes = (notesFile ? readFileSync(notesFile, 'utf8') : unreleased[1]).trim()
  if (!notes) throw new Error('Write the release notes under "## [Unreleased]" in CHANGELOG.md or pass --notes-file.')

  const call = await mcpClient('release')
  const workspaceId = await workspaceFor(call)
  // One gate covers typecheck, lint, unit and integration. Its canonical commandId returns the gate that already
  // ran on this exact commit (for example from the gate line) instead of starting a second full round.
  // --gate-ticket names a gate that already ran on this commit under another credential's commandId.
  const started = gateTicket ? await namedGate(call, workspaceId, gateTicket, commit)
    : await call('ci_run', { workspaceId, commit, suite: 'integration', scope: 'full', gate: true,
      priority: 'high', commandId: gateCommandId(commit) })
  const groups = [{ suite: 'gate', tickets: (started.partitions ?? [{ ticketId: started.ticketId }]).map(value => value.ticketId) }]
  console.error(`[release] Clean round for ${commit.slice(0, 12)}: ${groups.map(group => `${group.suite} (${group.tickets.length})`).join(', ')}`)
  if (reruns.size) {
    const problems = await gateRoundProblems(call, workspaceId, groups[0].tickets, commit, { reruns })
    if (problems.length) {
      console.error(`[release] No release: ${problems.join(' ')}`)
      return 1
    }
  } else {
    const finished = await awaitTickets(call, workspaceId, groups[0].tickets)
    groups[0].tickets = finished.map(run => run.id)
    const failed = finished.filter(run => run.state !== 'passed')
    if (failed.length) {
      console.error(`[release] No release: ${failed.map(run => `${run.suite} ticket ${run.id} ${run.state}`).join('; ')}`)
      return 1
    }
  }

  writeFileSync('package.json', manifest.replace(/"version": "[^"]*"/, `"version": "${version}"`))
  const entry = `## [Unreleased]\n\n## [${version}] - ${new Date().toISOString().slice(0, 10)}\n\n${notes}\n`
  writeFileSync('CHANGELOG.md', changelog.replace(unreleased[0], entry))
  git('add', 'package.json', 'CHANGELOG.md')
  const trailers = groups.map(group => `Clean-Round: ${group.suite}=${group.tickets.join(',')}`)
  trailers.push(...[...reruns].map(([failed, replacement]) => `Clean-Round-Rerun: ${failed}=${replacement}`))
  git('commit', '--quiet', '-m', `Release v${version}`, '-m', trailers.join('\n'))
  const problems = await releaseRoundProblems(call, workspaceId, git('rev-parse', 'HEAD'))
  if (problems.length) throw new Error(`The release commit does not verify: ${problems.join(' ')}`)
  git('push', '--quiet', 'origin', 'HEAD:main')
  console.error(`[release] Released v${version} as ${git('rev-parse', 'HEAD').slice(0, 12)}.`)
  return 0
}

async function namedGate(call, workspaceId, ticketId, commit) {
  const found = await call('ci_get', { workspaceId, ticketId })
  const group = found.partitions ?? [found.run]
  if (group.some(run => run.commit !== commit)) throw new Error(`Gate ticket ${ticketId} did not run on ${commit.slice(0, 12)}.`)
  return { ticketId: group[0].id, partitions: group.map(run => ({ ticketId: run.id })) }
}

const args = process.argv.slice(2)
const notesIndex = args.indexOf('--notes-file')
const notesFile = notesIndex >= 0 ? args.splice(notesIndex, 2)[1] : undefined
const gateIndex = args.indexOf('--gate-ticket')
const gateTicket = gateIndex >= 0 ? args.splice(gateIndex, 2)[1] : undefined
const rerunValues = []
while (args.includes('--rerun')) {
  rerunValues.push(args.splice(args.indexOf('--rerun'), 2)[1])
}
process.exitCode = await release(args[0], notesFile, gateTicket, rerunValues)
  .catch(error => { console.error(`[release] ${error.message}`); return 1 })
