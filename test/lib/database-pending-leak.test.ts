import {describe, it, expect, beforeAll} from 'vitest'
import database from '../../lib/database.js'
import type {Provider} from '../../lib/types.js'

const cid = 'bafybeiczorqqam64xocjjjq2vg7eixz6deyex5xbzehuurj45626rtljga'

const makeProvider = (id: string): Provider[] => [
  {Schema: 'bitswap', Protocol: 'transport-bitswap', Payload: {ID: id, Addrs: ['/ip4/0.0.0.0/tcp/4001']}}
]

// reproduces the pending-flag leak: addCidProvidersToDatabase serializes concurrent writes
// to the same cid with an in-memory pending flag. before the fix, a write that threw (e.g.
// "database is locked" past busy_timeout, issue #2's failure mode) never cleared the flag,
// so every later write for that cid spun on the pending poll loop forever: the announcement
// was never stored, the PUT never responded (clients abort mid-request), and once the cid's
// stored providers expired its GETs returned empty until the process restarted.
describe('pending flag leak on thrown write', () => {
  beforeAll(() => {
    database.memory()
    database.clear()
  })

  it('FIX: a thrown write clears the pending flag so later writes for the same cid still succeed', async () => {
    const store = database._private.providersKeyv()!
    const set = store.set.bind(store)

    // make the first write throw, like a write lock held past busy_timeout does
    store.set = () => {
      throw new Error('database is locked')
    }
    await expect(database._private.addCidProvidersToDatabase(cid, makeProvider('1'))).rejects.toThrow('database is locked')
    store.set = set

    // before the fix this never resolved: the leaked flag made it poll forever
    const nextWrite = database._private.addCidProvidersToDatabase(cid, makeProvider('2'))
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('write for the cid is wedged: pending flag leaked')), 1000))
    await expect(Promise.race([nextWrite, timeout])).resolves.toBeUndefined()

    // the later announcement is actually stored and served
    const {providers} = await database.getProviders(cid)
    expect(providers.map((provider) => provider.ID)).toEqual(['2'])
  })
})
