import {describe, it, expect, beforeAll, afterEach} from 'vitest'
import database from '../../lib/database.js'
import type {Provider} from '../../lib/types.js'

// to restore mocks
const DateNow = Date.now

const cid = 'bafybeiczorqqam64xocjjjq2vg7eixz6deyex5xbzehuurj45626rtljga'

const makeProvider = (id: string): Provider[] => [
  {Schema: 'bitswap', Protocol: 'transport-bitswap', Payload: {ID: id, Addrs: ['/ip4/0.0.0.0/tcp/4001']}}
]

describe('database', () => {
  beforeAll(() => {
    database.memory()
    database.clear()
  })
  afterEach(() => {
    database.clear()
  })

  describe('addCidProvidersToDatabase', () => {
    afterEach(() => {
      database.clear()
    })

    it('addCidProvidersToDatabase concurrent calls should not miss providers', async () => {
      const providers1 = makeProvider('1')
      const providers2 = makeProvider('2')
      const providers3 = makeProvider('3')
      const providers4 = makeProvider('4')
      const providers5 = makeProvider('5')

      const promises = [
        database._private.addCidProvidersToDatabase(cid, providers1),
        database._private.addCidProvidersToDatabase(cid, providers2),
        database._private.addCidProvidersToDatabase(cid, providers3),
        database._private.addCidProvidersToDatabase(cid, providers4),
        database._private.addCidProvidersToDatabase(cid, providers5)
      ]
      await Promise.all(promises)

      const {providers} = await database.getProviders(cid)
      const peerIds = providers.map(provider => provider.ID)
      expect(peerIds.includes(providers1[0].Payload.ID)).toBe(true)
      expect(peerIds.includes(providers2[0].Payload.ID)).toBe(true)
      expect(peerIds.includes(providers3[0].Payload.ID)).toBe(true)
      expect(peerIds.includes(providers4[0].Payload.ID)).toBe(true)
      expect(peerIds.includes(providers5[0].Payload.ID)).toBe(true)
    })

    it('addCidProvidersToDatabase should remove expired', async () => {
      const providers1 = makeProvider('1')
      const providers2 = makeProvider('2')

      await database._private.addCidProvidersToDatabase(cid, providers1)

      // mock date 10 years in the future
      const in10Years = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10
      Date.now = () => in10Years

      await database._private.addCidProvidersToDatabase(cid, providers2)
      const stored = database._private.providersKeyv()!.get(cid)!
      const providers = stored.providers
      expect(providers[providers1[0].Payload.ID]).toBe(undefined)
      expect(providers[providers2[0].Payload.ID]).not.toBe(undefined)
      expect(Object.keys(providers).length).toBe(1)

      // restore mock
      Date.now = DateNow
    })
  })

  describe('sweep', () => {
    it('sweep should physically delete rows whose providers are all expired', async () => {
      await database._private.addCidProvidersToDatabase(cid, makeProvider('1'))
      // row exists before sweeping
      expect(database._private.providersKeyv()!.get(cid)).not.toBe(undefined)

      // mock date 10 years in the future so the whole row is past the ttl
      const in10Years = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10
      Date.now = () => in10Years

      await database._private.sweep()

      // row is physically gone, not just filtered out on read
      expect(database._private.providersKeyv()!.get(cid)).toBe(undefined)

      // restore mock
      Date.now = DateNow
    })

    it('sweep should keep rows that are still within the ttl', async () => {
      await database._private.addCidProvidersToDatabase(cid, makeProvider('1'))

      await database._private.sweep()

      expect(database._private.providersKeyv()!.get(cid)).not.toBe(undefined)
    })
  })

  describe('getProviders', () => {
    describe('large amount of providers in db', () => {
      let res: Awaited<ReturnType<typeof database.getProviders>>
      beforeAll(async () => {
        let count = 200
        const providersToAdd: Provider[][] = []
        while (count--) {
          providersToAdd.push(makeProvider(String(providersToAdd.length + 1)))
        }
        // add all providers
        for (const provider of providersToAdd) {
          await database._private.addCidProvidersToDatabase(cid, provider)
        }
        res = await database.getProviders(cid)
      })
      it('should not return more than 100 providers', () => {
        expect(res.providers.length).toBe(100)
      })
    })
  })

  describe('expired providers in db', () => {
    const providers1 = makeProvider('1')
    const providers2 = makeProvider('2')
    let res: Awaited<ReturnType<typeof database.getProviders>>
    beforeAll(async () => {
      await database._private.addCidProvidersToDatabase(cid, providers1)

      // mock date 10 years in the future
      const in10Years = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10
      Date.now = () => in10Years

      await database._private.addCidProvidersToDatabase(cid, providers2)
      res = await database.getProviders(cid)

      // restore mock
      Date.now = DateNow
    })
    it('should not return expired providers', () => {
      const peerIds = res.providers.map(provider => provider.ID)
      expect(peerIds.includes(providers1[0].Payload.ID)).toBe(false)
      expect(peerIds.includes(providers2[0].Payload.ID)).toBe(true)
      expect(res.providers.length).toBe(1)
    })
  })
})
