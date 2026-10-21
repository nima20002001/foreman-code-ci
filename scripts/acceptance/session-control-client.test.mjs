import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionControlHeaders } from './session-control-client.mjs'

test('local human HTTP requests carry no login credential or invented browser origin', () => {
  assert.deepEqual(sessionControlHeaders({ baseUrl: 'http://127.0.0.1:3040' }), {
    'content-type': 'application/json',
  })
})

test('browser clients use the configured origin instead of the API port', () => {
  assert.equal(sessionControlHeaders({ baseUrl: 'http://127.0.0.1:3040', browserOrigin: 'http://localhost:5173' }).origin,
    'http://localhost:5173')
  assert.throws(() => sessionControlHeaders({ browserOrigin: 'http://localhost:5173/unreviewed' }))
  assert.throws(() => sessionControlHeaders({ browserOrigin: 'https://another.example' }))
})
