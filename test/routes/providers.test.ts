import {describe, it, expect, beforeAll, afterAll} from 'vitest'
import database from '../../lib/database.js'
import {request, closeServer} from '../helpers/request.js'

const mockIp = '123.123.123.123'

const body = {
  Providers: [
    {
      Schema: 'bitswap',
      Protocol: 'transport-bitswap',
      Signature: 'mx5kamm5kzxuCnVJtX3K9DEj8gKlFqXil2x/M8zDTozvzowTY6W+HOALQ2LCkTZCEz4H5qizpnHxPM/rVQ7MNBg',
      Payload: {
        Keys: [
          'bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e',
          'bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e'
        ],
        Timestamp: 1725833163372,
        AdvisoryTTL: 86400000000000,
        ID: '12D3KooWEdCRaQTjjgbtBoSMhnguznp7GHhsin8eRDEtgEso6Z1B',
        Addrs: [
          `/ip4/${mockIp}/tcp/4001`,
          `/ip4/${mockIp}/udp/4001/quic-v1`,
          `/ip4/${mockIp}/udp/4001/quic-v1/webtransport`,
        ]
      }
    }
  ]
}

// used to mock the ip address (trust proxy is enabled)
const headers = {
  'user-agent': 'kubo/0.29.0/',
  'accept-encoding': 'gzip',
  'x-forwarded-for': mockIp
}

describe('routes providers', () => {
  beforeAll(() => {
    database.memory()
    database.clear()
  })
  afterAll(async () => {
    database.clear()
    await closeServer()
  })

  describe('PUT /routing/v1/providers/', () => {
    let res: Awaited<ReturnType<typeof request>>
    beforeAll(async () => {
      res = await request('PUT', '/routing/v1/providers/', {headers, body})
    })
    afterAll(() => {
      database.clear()
    })
    it('should return status 200', () => {
      expect(res.status).toBe(200)
    })
    it('body should contain result', () => {
      expect(res.body).toEqual({
        ProvideResults: [
          {
            Schema: 'bitswap',
            Protocol: 'transport-bitswap',
            AdvisoryTTL: 86400000000000
          }
        ]
      })
    })
    it('should have content-type header', () => {
      expect(res.headers['content-type']?.includes('json')).toBe(true)
    })
    it('database should have provider', async () => {
      const {providers} = await database.getProviders(body.Providers[0].Payload.Keys[0])
      expect(providers.length).toBe(1)
    })
  })

  describe('PUT /routing/v1/providers/ with non rep.iq ip addresses', () => {
    let res: Awaited<ReturnType<typeof request>>
    const badIps = [
      // local ips
      `/ip4/192.168.0.1/tcp/4001`,
      `/ip4/127.0.0.1/tcp/4001`,
      // public but different from req.iq
      `/ip4/8.8.8.8/tcp/4001`,
      `/ip4/9.9.9.9/tcp/4001`,
    ]
    const bodyWithBadIps = JSON.parse(JSON.stringify(body))
    bodyWithBadIps.Providers[0].Payload.Addrs.push(...badIps)
    beforeAll(async () => {
      res = await request('PUT', '/routing/v1/providers/', {headers, body: bodyWithBadIps})
    })
    afterAll(() => {
      database.clear()
    })
    it('should return status 200', () => {
      expect(res.status).toBe(200)
    })
    it('database should have provider but not with bad ips', async () => {
      const {providers} = await database.getProviders(body.Providers[0].Payload.Keys[0])
      expect(providers.length).toBe(1)
      expect(providers[0].Addrs.length).toBeGreaterThan(0)
      // TODO: uncomment this after we no longer transform 0.0.0.0 into req.ip
      expect(providers[0].Addrs.length).toBe(body.Providers[0].Payload.Addrs.length)
      for (const badIp of badIps) {
        expect(providers[0].Addrs.includes(badIp)).toBe(false)
      }
    })
  })

  describe('PUT /routing/v1/providers/ with no addresses', () => {
    let res: Awaited<ReturnType<typeof request>>
    const bodyWithNoAddresses = JSON.parse(JSON.stringify(body))
    bodyWithNoAddresses.Providers[0].Payload.Addrs = []
    beforeAll(async () => {
      res = await request('PUT', '/routing/v1/providers/', {headers, body: bodyWithNoAddresses})
    })
    afterAll(() => {
      database.clear()
    })
    it('should return status 200', () => {
      expect(res.status).toBe(200)
    })
    it('database should not have provider', async () => {
      const {providers} = await database.getProviders(body.Providers[0].Payload.Keys[0])
      expect(providers.length).toBe(0)
    })
  })

  describe('GET /routing/v1/providers/ has providers', () => {
    let res: Awaited<ReturnType<typeof request>>
    beforeAll(async () => {
      await request('PUT', '/routing/v1/providers/', {headers, body})
      res = await request('GET', `/routing/v1/providers/${body.Providers[0].Payload.Keys[0]}`, {headers})
    })
    afterAll(() => {
      database.clear()
    })
    it('should return status 200', () => {
      expect(res.status).toBe(200)
    })
    it('should have last-modified header', () => {
      expect(typeof res.headers['last-modified']).toBe('string')
    })
    it('should have content-type header', () => {
      expect(res.headers['content-type']?.includes('json')).toBe(true)
    })
    it('should have cache-control header', () => {
      expect(typeof res.headers['cache-control']).toBe('string')
    })
    it('should contain provider', () => {
      expect(res.body.Providers[0].Schema).toBe('peer')
      expect(res.body.Providers[0].ID).toBe(body.Providers[0].Payload.ID)
      expect(res.body.Providers[0].Protocols[0]).toBe(body.Providers[0].Protocol)
      expect(res.body.Providers[0].Addrs).toEqual(body.Providers[0].Payload.Addrs)
    })
  })

  describe('GET /routing/v1/providers/ does not have providers', () => {
    const unknownCid = 'bafybeigvgzoolc3drupxhlevdp2ugqcrbcsqfmcek2zxiw5wctk3xjpjwy'
    let res: Awaited<ReturnType<typeof request>>
    beforeAll(async () => {
      res = await request('GET', `/routing/v1/providers/${unknownCid}`, {headers})
    })
    it('should return status 404', () => {
      expect(res.status).toBe(404)
    })
    it('should not have last-modified header', () => {
      expect(res.headers['last-modified']).toBe(undefined)
    })
    it('should have content-type header', () => {
      expect(res.headers['content-type']?.includes('json')).toBe(true)
    })
    it('should have cache-control header', () => {
      expect(typeof res.headers['cache-control']).toBe('string')
    })
    it('should contain no providers', () => {
      expect(res.body.Providers).toBe(null)
    })
  })

  describe('PUT /routing/v1/providers/ dag-pb codec, GET /routing/v1/providers/ raw codec', () => {
    const dagPbCodecCid = 'QmSf6sTLvGrCzpLcqdRLy8xUmLUhgdyAQi1VaFy7Aa2VHW'
    const rawCodecCid = 'bafkreicafdegmgvhbsc4z4whwcz3wjdoeu3jpcuy2mfckqtq5dikjelzau'
    const dagPbBody = {
      Providers: [
        {
          Schema: 'bitswap',
          Protocol: 'transport-bitswap',
          Signature: 'mx5kamm5kzxuCnVJtX3K9DEj8gKlFqXil2x/M8zDTozvzowTY6W+HOALQ2LCkTZCEz4H5qizpnHxPM/rVQ7MNBg',
          Payload: {
            Keys: [dagPbCodecCid],
            Timestamp: 1725833163372,
            AdvisoryTTL: 86400000000000,
            ID: '12D3KooWEdCRaQTjjgbtBoSMhnguznp7GHhsin8eRDEtgEso6Z1B',
            Addrs: [
              `/ip4/${mockIp}/tcp/4001`,
              `/ip4/${mockIp}/udp/4001/quic-v1`,
              `/ip4/${mockIp}/udp/4001/quic-v1/webtransport`,
            ]
          }
        }
      ]
    }
    let dagPbCodecCidRes: Awaited<ReturnType<typeof request>>
    let rawCodecCidRes: Awaited<ReturnType<typeof request>>
    beforeAll(async () => {
      await request('PUT', '/routing/v1/providers/', {headers, body: dagPbBody})
      dagPbCodecCidRes = await request('GET', `/routing/v1/providers/${dagPbCodecCid}`, {headers})
      rawCodecCidRes = await request('GET', `/routing/v1/providers/${rawCodecCid}`, {headers})
    })
    afterAll(() => {
      database.clear()
    })
    it('database should have provider for dag-pb codec cid', async () => {
      const {providers} = await database.getProviders(dagPbCodecCid)
      expect(providers.length).toBe(1)
    })
    it('dag-pb codec cid res should have provider', () => {
      expect(dagPbCodecCidRes.status).toBe(200)
      expect(dagPbCodecCidRes.body.Providers[0].Schema).toBe('peer')
      expect(dagPbCodecCidRes.body.Providers[0].ID).toBe(dagPbBody.Providers[0].Payload.ID)
      expect(dagPbCodecCidRes.body.Providers[0].Protocols[0]).toBe(dagPbBody.Providers[0].Protocol)
      expect(dagPbCodecCidRes.body.Providers[0].Addrs).toEqual(dagPbBody.Providers[0].Payload.Addrs)
    })
    it('database should have provider for raw codec cid', async () => {
      const {providers} = await database.getProviders(rawCodecCid)
      expect(providers.length).toBe(1)
    })
    it('raw codec cid res should have provider', () => {
      expect(rawCodecCidRes.status).toBe(200)
      expect(rawCodecCidRes.body.Providers[0].Schema).toBe('peer')
      expect(rawCodecCidRes.body.Providers[0].ID).toBe(dagPbBody.Providers[0].Payload.ID)
      expect(rawCodecCidRes.body.Providers[0].Protocols[0]).toBe(dagPbBody.Providers[0].Protocol)
      expect(rawCodecCidRes.body.Providers[0].Addrs).toEqual(dagPbBody.Providers[0].Payload.Addrs)
    })
  })
})
