import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { localHumanProxyRequest } from './localClientNode.js'
import { APP_MCP_TOKEN_NAMES } from './product.js'

const runClient = promisify(execFile)

describe.skipIf(!['linux', 'darwin'].includes(process.platform))('local HTTP process separation', () => {
  it.each(APP_MCP_TOKEN_NAMES)('accepts credential-free setup HTTP and denies a %s client without a native cgroup', async tokenName => {
    const server = createServer((request, response) => {
      void localHumanProxyRequest(request, response, error => {
        response.writeHead(error ? 500 : 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ready: !error }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.')
      const url = `http://127.0.0.1:${address.port}/api/local-human`
      const human = await fetch(url)
      expect(human.status).toBe(200)
      expect(await human.json()).toEqual({ ready: true })
      const setupEnvironment = { ...process.env }
      for (const name of APP_MCP_TOKEN_NAMES) delete setupEnvironment[name]
      const setup = await runClient(process.execPath, ['--input-type=module', '-e', `
        const response = await fetch(${JSON.stringify(url)});
        console.log(JSON.stringify({ status: response.status, body: await response.json() }));
      `], { env: setupEnvironment, timeout: 10_000 })
      expect(JSON.parse(setup.stdout)).toEqual({ status: 200, body: { ready: true } })
      const script = `
        const results = [];
        for (const headers of [{}, { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' }]) {
          const response = await fetch(${JSON.stringify(url)}, { headers });
          results.push({ status: response.status, body: await response.json() });
        }
        console.log(JSON.stringify(results));
      `
      const independent = await runClient(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...setupEnvironment, [tokenName]: 'restricted-client-credential' }, timeout: 10_000,
      })
      expect(JSON.parse(independent.stdout)).toEqual(Array(2).fill({ status: 403,
        body: { error: { code: 'LOCAL_HUMAN_REQUIRED', message: 'Agent processes require an application credential.' } },
      }))
      const credentialed = await fetch(url, { headers: { authorization: 'Bearer restricted-client-credential' } })
      expect(credentialed.status).toBe(200)
      await credentialed.body?.cancel()
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
