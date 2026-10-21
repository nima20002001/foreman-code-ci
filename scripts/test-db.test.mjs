import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeDatabase } from './test-db.mjs'

const runId = '11111111-1111-4111-8111-111111111111'
const project = `foreman-ci-${runId}`
const stale = 'foreman-ci-22222222-2222-4222-8222-222222222222'
const live = 'foreman-ci-33333333-3333-4333-8333-333333333333'

function dockerFixture({ failure, networkOnly = false, preserveStale = false } = {}) {
  const projects = [stale, live, 'foreman-ci-pg-retained', 'fx-stopped', 'fx-running', 'production']
  const networks = new Map(projects.map(name => [`${name}_default`, name]))
  const containers = new Map(projects.filter(() => !networkOnly).map(name => [`${name}-postgres`, name]))
  const calls = []
  function docker(args) {
    calls.push(args)
    if (args[0] === 'network' && args[1] === 'ls') return [...networks.keys()].join('\n')
    if (args[0] === 'network' && args[1] === 'inspect') {
      return JSON.stringify([{ Name: args[2], Labels: { 'com.docker.compose.project': networks.get(args[2]) } }])
    }
    if (args[0] === 'ps') {
      const label = args.find(value => value.startsWith('label=com.docker.compose.project='))
      return [...containers].filter(([, name]) => !label || label.endsWith(`=${name}`))
        .map(([id]) => id).join('\n')
    }
    if (args[0] === 'inspect') {
      const name = containers.get(args[1])
      return JSON.stringify([{ Config: { Labels: { 'com.docker.compose.project': name,
        'com.docker.compose.service': 'postgres', 'graphql.test-owner': 'disposable-tests' } },
      State: { Running: name !== 'fx-stopped' } }])
    }
    if (args[0] === 'rm') {
      for (const id of args.slice(2)) containers.delete(id)
    }
    if (args[0] === 'network' && args[1] === 'rm') networks.delete(args[2])
    if (args[0] === 'compose') {
      const name = args[args.indexOf('--project-name') + 1]
      if (args.includes('up')) {
        assert.equal(networks.has(`${stale}_default`), preserveStale, 'orphan cleanup must precede startup')
        networks.set(`${name}_default`, name)
        containers.set(`${name}-postgres`, name)
      }
      if (args.includes(failure)) throw new Error(`failed ${failure}`)
      if (args.includes('down')) {
        containers.delete(`${name}-postgres`)
        networks.delete(`${name}_default`)
      }
    }
    return ''
  }
  return { docker, calls, networks, containers }
}

function options(fixture, environment = {}) {
  return { docker: fixture.docker, environment,
    isProjectLive: name => name === live }
}

test('startup reclaims orphan CI containers and networks while preserving live slots and other projects', () => {
  const fixture = dockerFixture()
  composeDatabase('up', options(fixture))
  assert.equal(fixture.containers.has(`${stale}-postgres`), false)
  assert.equal(fixture.networks.has(`${stale}_default`), false)
  for (const name of [live, 'foreman-ci-pg-retained', 'fx-running', 'production']) {
    assert.equal(fixture.networks.has(`${name}_default`), true)
    assert.equal(fixture.containers.has(`${name}-postgres`), true)
  }
  assert.equal(fixture.networks.has('fx-stopped_default'), false)
})

test('startup reclaims networks left after their CI containers were already removed', () => {
  const fixture = dockerFixture({ networkOnly: true })
  composeDatabase('up', options(fixture))
  assert.equal(fixture.networks.has(`${stale}_default`), false)
  assert.equal(fixture.networks.has(`${live}_default`), true)
  assert.equal(fixture.networks.has('production_default'), true)
})

for (const failure of ['up', 'exec']) {
  test(`failed ${failure} removes the partially created fixture project and network`, () => {
    const fixture = dockerFixture({ failure })
    const environment = { COMPOSE_PROJECT_NAME: 'fx-startup' }
    assert.throws(() => composeDatabase('up', options(fixture, environment)), new RegExp(`failed ${failure}`))
    assert.equal(fixture.networks.has('fx-startup_default'), false)
    assert.equal(fixture.containers.has('fx-startup-postgres'), false)
  })
}

test('teardown removes CI containers and network even when compose down fails', () => {
  const fixture = dockerFixture({ failure: 'down' })
  fixture.networks.set(`${project}_default`, project)
  fixture.containers.set(`${project}-postgres`, project)
  assert.throws(() => composeDatabase('down', options(fixture, { FOREMAN_CODE_CI_HOST_RUN_ID: runId })), /failed down/)
  assert.equal(fixture.networks.has(`${project}_default`), false)
  assert.equal(fixture.containers.has(`${project}-postgres`), false)
  assert.equal(fixture.networks.has('production_default'), true)
})

test('fixture teardown removes its compose containers and network after compose down fails', () => {
  const fixture = dockerFixture({ failure: 'down' })
  assert.throws(() => composeDatabase('down', options(fixture, { COMPOSE_PROJECT_NAME: 'fx-running' })), /failed down/)
  assert.equal(fixture.networks.has('fx-running_default'), false)
  assert.equal(fixture.containers.has('fx-running-postgres'), false)
  assert.equal(fixture.networks.has(`${live}_default`), true)
})

test('startup tolerates a resource another slot removed between listing and inspecting it', () => {
  const fixture = dockerFixture()
  const docker = fixture.docker
  const vanished = `${stale}-postgres`
  fixture.docker = args => {
    if (args[0] === 'inspect' && args[1] === vanished) {
      fixture.containers.delete(vanished)
      throw new Error(`error: no such object: ${vanished}`)
    }
    return docker(args)
  }
  composeDatabase('up', options(fixture))
  assert.equal(fixture.networks.has(`${stale}_default`), false)
  assert.equal(fixture.networks.has(`${live}_default`), true)
})

test('an unknown live-slot status preserves its CI resources', () => {
  const fixture = dockerFixture({ preserveStale: true })
  composeDatabase('up', { ...options(fixture), isProjectLive: () => true,
    environment: { COMPOSE_PROJECT_NAME: 'fx-safe' } })
  assert.equal(fixture.networks.has(`${stale}_default`), true)
  assert.equal(fixture.containers.has(`${stale}-postgres`), true)
})
