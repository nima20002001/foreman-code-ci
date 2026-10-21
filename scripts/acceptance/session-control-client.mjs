import assert from 'node:assert/strict'

/** Restoring Claude defaults can invoke native qualification; the fixture must also use Haiku. */
export function assertSessionControlDefaults(defaults) {
  const configuration = defaults.value.operator.harness
  if (configuration.harness === 'claude') {
    assert.ok(['haiku', 'claude-haiku-4-5-20251001'].includes(configuration.model),
      'Use explicit Haiku Operator defaults in the disposable fixture before provisioning.')
  }
}

export function sessionControlHeaders(matrix) {
  const headers = { 'content-type': 'application/json' }
  if (matrix.browserOrigin) {
    const origin = new URL(matrix.browserOrigin)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use the configured local browser origin.')
    assert.equal(origin.href, `${origin.origin}/`, 'Provide an origin without a path, query or fragment.')
    headers.origin = origin.origin
  }
  return headers
}
