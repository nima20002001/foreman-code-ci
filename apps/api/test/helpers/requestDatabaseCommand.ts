import type { LightMyRequestResponse } from 'fastify'
import { setTimeout as delay } from 'node:timers/promises'

/** The caller retains the original request, including its commandId, for every attempt. */
export async function requestDatabaseCommand(
  request: () => Promise<LightMyRequestResponse>,
): Promise<LightMyRequestResponse> {
  for (let attempt = 1; ; attempt++) {
    const response = await request()
    if (response.statusCode !== 503 || attempt === 10) return response
    const error = response.json().error
    if (error?.code !== 'DATABASE_BUSY' || error.details?.retryable !== true) return response
    // Pool acquisition already waits one second; let other work release its lease before resubmitting.
    await delay(100)
  }
}
