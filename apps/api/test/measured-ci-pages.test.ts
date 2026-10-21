import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { measuredCiPages } from './helpers/measuredCiPages.js'

function connection(initialPages: number, reads: number[]) {
  let pages = initialPages
  let readCount = 0
  return {
    async query(text: string) {
      if (text === 'measured read') {
        pages += reads[readCount++] ?? 0
        return { rows: [{ readCount }] }
      }
      return { rows: [{ pages }] }
    },
    on: vi.fn(),
    removeListener: vi.fn(),
    release: vi.fn(),
  }
}

function fixture(...clients: ReturnType<typeof connection>[]) {
  let next = 0
  const pool = { connect: async () => clients[next++]! } as unknown as pg.Pool
  return measuredCiPages(pool)
}

describe('CI heap page measurement', () => {
  it('excludes pages left by fixture setup on a reused connection', async () => {
    const measured = fixture(connection(381, [7]))
    const client = await measured.pool.connect()
    expect((await client.query('measured read')).rows).toEqual([{ readCount: 1 }])
    expect(measured.pages.max).toBe(7)
    client.release()
  })

  it('counts repeated reads together on the wrapped connection', async () => {
    const measured = fixture(connection(0, [7, 11]))
    const client = await measured.pool.connect()
    await client.query('measured read')
    await client.query('measured read')
    expect(measured.pages.max).toBe(18)
    client.release()
  })

  it('retains a full scan above the integration page bound', async () => {
    const measured = fixture(connection(381, [300]))
    const client = await measured.pool.connect()
    await client.query('measured read')
    expect(measured.pages.max).toBeGreaterThanOrEqual(100)
    client.release()
  })

  it('compares separate wrapped connections without their earlier page counts', async () => {
    const measured = fixture(connection(381, [7]), connection(2000, [11]))
    for (let index = 0; index < 2; index++) {
      const client = await measured.pool.connect()
      await client.query('measured read')
      client.release()
    }
    expect(measured.pages.max).toBe(11)
  })
})
