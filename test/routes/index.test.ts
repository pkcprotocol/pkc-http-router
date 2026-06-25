import {describe, it, expect, afterAll} from 'vitest'
import {request, closeServer} from '../helpers/request.js'

describe('routes index', () => {
  afterAll(closeServer)

  describe('GET /', () => {
    it('should welcome', async () => {
      const res = await request('GET', '/')
      expect(res.status).toBe(200)
      expect(res.text).toBe('Welcome to an IPFS tracker.')
    })
  })
})
