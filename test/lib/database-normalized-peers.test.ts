import {describe, it, expect, beforeAll, afterEach} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import database from '../../lib/database.js'
import type {Provider, CidProviders} from '../../lib/types.js'

// to restore mocks
const DateNow = Date.now

const {ProvidersStore} = database._private

// production database.sqlite grew to 2.2gb because every cid row stored a full copy of
// its providers' ~1kb records (addrs with webtransport certhashes, autotls dns names),
// and a single peer announced 1.24 million cids. the store now normalizes: one shared
// record per peer in `peers`, one tiny (cid, peerId) row per announcement in `cidProviders`.

const cids = [
  'bafybeiczorqqam64xocjjjq2vg7eixz6deyex5xbzehuurj45626rtljga',
  'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354',
  'bafybeic2vguwwzo4dddbxjas4pzlpbujxxi7erqfkwhmm2pls6c4q6iizm'
]

const makeProvider = (id: string, keys: string[], addrs = ['/ip4/1.2.3.4/tcp/4001']): Provider[] => [
  {Schema: 'bitswap', Protocol: 'transport-bitswap', Payload: {ID: id, Keys: keys, Addrs: addrs}}
]

const tmpDbFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkc-normalize-'))
  return path.join(dir, 'database.sqlite')
}

describe('normalized peers table', () => {
  beforeAll(() => {
    database.memory()
    database.clear()
  })
  afterEach(() => {
    database.clear()
    Date.now = DateNow
  })

  it('a peer announcing many cids is stored as a single shared peer record', async () => {
    await database.addProviders(makeProvider('peer1', cids))

    const counts = database._private.providersKeyv()!.counts()
    expect(counts.peers).toBe(1)
    expect(counts.cidProviders).toBe(cids.length)

    // every cid still resolves to the peer with its full record
    for (const cid of cids) {
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(1)
      expect(providers[0].ID).toBe('peer1')
      expect(providers[0].Addrs).toEqual(['/ip4/1.2.3.4/tcp/4001'])
    }
  })

  it('a new announce updates the shared peer record returned for every cid', async () => {
    await database.addProviders(makeProvider('peer1', [cids[0]], ['/ip4/1.2.3.4/tcp/4001']))
    // the peer re-announces a different cid with new addrs (e.g. its ip changed)
    await database.addProviders(makeProvider('peer1', [cids[1]], ['/ip4/5.6.7.8/tcp/4001']))

    // the first cid now returns the fresh addrs too, instead of a stale per-cid snapshot
    const {providers} = await database.getProviders(cids[0])
    expect(providers[0].Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])
  })

  it('an older entry cannot regress the shared peer record with stale addrs', () => {
    const store = database._private.providersKeyv()!
    const entry = (addrs: string[], lastModified: number): CidProviders => ({
      providers: {peer1: {provider: {Schema: 'peer', Addrs: addrs, ID: 'peer1', Protocols: ['transport-bitswap']}, lastModified}},
      lastModified
    })

    store.set(cids[0], entry(['/ip4/5.6.7.8/tcp/4001'], 200_000))
    // a write carrying an older lastModified for the same peer (e.g. two in-flight
    // announces committing out of order) must not overwrite the newer record
    store.set(cids[1], entry(['/ip4/1.2.3.4/tcp/4001'], 100_000))

    expect(store.get(cids[0])!.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])
    expect(store.get(cids[1])!.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])
  })

  it('sweep deletes the shared peer record once all its announcements expired', async () => {
    await database.addProviders(makeProvider('peer1', [cids[0]]))
    expect(database._private.providersKeyv()!.counts()).toEqual({peers: 1, cidProviders: 1})

    // mock date 10 years in the future so everything is past the ttl
    const in10Years = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10
    Date.now = () => in10Years

    await database._private.sweep()

    expect(database._private.providersKeyv()!.counts()).toEqual({peers: 0, cidProviders: 0})
  })
})

describe('legacy providers table migration', () => {
  const legacyValue = (providers: Record<string, {addrs: string[]; lastModified: number}>): string => {
    const value: CidProviders = {providers: {}, lastModified: 0}
    for (const peerId in providers) {
      value.providers[peerId] = {
        provider: {Schema: 'peer', Addrs: providers[peerId].addrs, ID: peerId, Protocols: ['transport-bitswap']},
        lastModified: providers[peerId].lastModified
      }
      value.lastModified = Math.max(value.lastModified, providers[peerId].lastModified)
    }
    return JSON.stringify(value)
  }

  // the exact schema running in production before normalization
  const createLegacyDb = (file: string, {withLastModifiedColumn = true} = {}): DatabaseSync => {
    const db = new DatabaseSync(file)
    if (withLastModifiedColumn) {
      db.exec('CREATE TABLE providers (key TEXT PRIMARY KEY, value TEXT NOT NULL, lastModified INTEGER NOT NULL DEFAULT 0) STRICT')
      db.exec('CREATE INDEX providers_lastModified ON providers (lastModified)')
    } else {
      // the oldest production schema, before lastModified was mirrored to a column
      db.exec('CREATE TABLE providers (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    }
    return db
  }

  const seedLegacyRows = (db: DatabaseSync): void => {
    const insert = db.prepare('INSERT INTO providers (key, value) VALUES (?, ?)')
    // peer1 is announced for two cids with different snapshots of its addrs (the newer
    // one must win), peer2 for one of them
    insert.run(cids[0], legacyValue({
      peer1: {addrs: ['/ip4/1.2.3.4/tcp/4001'], lastModified: 100_000},
      peer2: {addrs: ['/ip4/9.9.9.9/tcp/4001'], lastModified: 150_000}
    }))
    insert.run(cids[1], legacyValue({
      peer1: {addrs: ['/ip4/5.6.7.8/tcp/4001'], lastModified: 200_000}
    }))
  }

  const expectMigrated = (store: InstanceType<typeof ProvidersStore>, file: string): void => {
    // peer1 deduplicated to a single record, its newest addrs won
    expect(store.counts()).toEqual({peers: 2, cidProviders: 3})
    const cid0 = store.get(cids[0])!
    expect(Object.keys(cid0.providers).sort()).toEqual(['peer1', 'peer2'])
    expect(cid0.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])
    expect(cid0.providers['peer1'].lastModified).toBe(100_000)
    expect(cid0.providers['peer2'].provider.Addrs).toEqual(['/ip4/9.9.9.9/tcp/4001'])
    expect(cid0.lastModified).toBe(150_000)
    expect(store.get(cids[1])!.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])

    // the legacy table is gone
    const inspect = new DatabaseSync(file)
    const legacyTable = inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'").get()
    expect(legacyTable).toBe(undefined)
    inspect.close()
  }

  it('migrates the pre-normalization schema in place on startup', () => {
    const file = tmpDbFile()
    const legacyDb = createLegacyDb(file)
    seedLegacyRows(legacyDb)
    legacyDb.close()

    const store = new ProvidersStore(file)
    expectMigrated(store, file)
  })

  it('migrates the oldest schema without a lastModified column', () => {
    const file = tmpDbFile()
    const legacyDb = createLegacyDb(file, {withLastModifiedColumn: false})
    seedLegacyRows(legacyDb)
    legacyDb.close()

    const store = new ProvidersStore(file)
    expectMigrated(store, file)
  })

  it('does not run the migration again on an already migrated database', () => {
    const file = tmpDbFile()
    const legacyDb = createLegacyDb(file)
    seedLegacyRows(legacyDb)
    legacyDb.close()

    let store = new ProvidersStore(file)
    // a write after migration must survive reopening the store
    store.set(cids[2], {providers: {peer3: {provider: {Schema: 'peer', Addrs: ['/ip4/2.2.2.2/tcp/4001'], ID: 'peer3', Protocols: ['transport-bitswap']}, lastModified: 300}}, lastModified: 300})

    store = new ProvidersStore(file)
    expect(store.counts()).toEqual({peers: 3, cidProviders: 4})
    expect(store.get(cids[2])!.providers['peer3'].provider.Addrs).toEqual(['/ip4/2.2.2.2/tcp/4001'])
  })

  it('vacuum during migration shrinks the file to the normalized size', () => {
    const file = tmpDbFile()
    const legacyDb = createLegacyDb(file)
    // one heavy peer record duplicated into many cid rows, like production
    const insert = legacyDb.prepare('INSERT INTO providers (key, value) VALUES (?, ?)')
    const addrs = Array.from({length: 10}, (_, i) => `/ip4/91.234.199.189/udp/4001/quic-v1/webtransport/certhash/uEiAOG9izJlviOJcRCtgUPy8a0_PL2E0EyGMuJL4Dki1GXQ${i}`)
    for (let i = 0; i < 2000; i++) {
      insert.run(`cid${i}`, legacyValue({peer1: {addrs, lastModified: 100}}))
    }
    legacyDb.close()
    const legacySize = fs.statSync(file).size

    new ProvidersStore(file)

    // the ~1kb record is now stored once instead of 2000 times
    const migratedSize = fs.statSync(file).size
    expect(migratedSize).toBeLessThan(legacySize / 5)
  })
})
