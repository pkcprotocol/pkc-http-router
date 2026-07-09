import {describe, it, expect, afterAll} from 'vitest'
import {startServer, closeServer} from '../helpers/request.js'

// reproduces the hanging metrics GET: the route wrote the body with res.write() and never
// called res.end(), so the chunked response never terminated and every scrape (including
// GET /routing/v1/providers/metrics/prometheus, which real clients can hit through the
// providers proxy prefix) hung until the client timed out
const fetchTextOrTimeout = async (url: string): Promise<string> =>
  Promise.race([
    fetch(url).then((res) => res.text()),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('response never completed: res.end() missing')), 2000))
  ])

describe('GET metrics', () => {
  afterAll(async () => {
    await closeServer()
  })

  it('FIX: /metrics/prometheus response completes instead of hanging forever', async () => {
    const base = await startServer()
    const text = await fetchTextOrTimeout(base + '/metrics/prometheus')
    expect(text).toContain('ipfs_tracker_up 1')
  })

  it('FIX: the providers-prefixed mount completes too', async () => {
    const base = await startServer()
    const text = await fetchTextOrTimeout(base + '/routing/v1/providers/metrics/prometheus')
    expect(text).toContain('ipfs_tracker_up 1')
  })
})
