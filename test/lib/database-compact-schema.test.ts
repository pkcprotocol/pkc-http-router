import {describe, it, expect, afterEach} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {CID} from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import database from '../../lib/database.js'
import type {CidProviders} from '../../lib/types.js'

// to restore mocks
const DateNow = Date.now

const {ProvidersStore} = database._private

// production database.sqlite was 332mb for ~1m announcements because every cidProviders
// row stored the cid as a 59-char base32 string, the peerId as a 52-char base58 string
// (despite only ~44 distinct peers) and a millisecond timestamp — and the lastModified
// index duplicated all of it. the compact schema stores the cid as its raw ~36 bytes,
// the peer as a small integer reference into `peers`, and second-precision timestamps.

const dagPbCodec = 0x70
const sha256Code = 0x12

// deterministic valid cids, same shape as production keys (cidv1 dag-pb base32)
const makeCid = (i: number): string => {
  const hash = crypto.createHash('sha256').update(`cid${i}`).digest()
  return CID.create(1, dagPbCodec, Digest.create(sha256Code, hash)).toString()
}

const cids = [makeCid(0), makeCid(1), makeCid(2)]

const entry = (peerId: string, addrs: string[], lastModified: number): CidProviders => ({
  providers: {[peerId]: {provider: {Schema: 'peer', Addrs: addrs, ID: peerId, Protocols: ['transport-bitswap']}, lastModified}},
  lastModified
})

const tmpDbFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkc-compact-'))
  return path.join(dir, 'database.sqlite')
}

// the exact schema running in production before the compact rewrite: text cid, text
// peerId repeated per announcement, millisecond timestamps
const createDenormalizedDb = (file: string): DatabaseSync => {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE peers (id TEXT PRIMARY KEY, provider TEXT NOT NULL, lastModified INTEGER NOT NULL) STRICT')
  db.exec('CREATE TABLE cidProviders (cid TEXT NOT NULL, peerId TEXT NOT NULL, lastModified INTEGER NOT NULL, PRIMARY KEY (cid, peerId)) STRICT, WITHOUT ROWID')
  db.exec('CREATE INDEX cidProviders_lastModified ON cidProviders (lastModified)')
  db.exec('CREATE INDEX peers_lastModified ON peers (lastModified)')
  return db
}

const providerJson = (peerId: string, addrs: string[]): string =>
  JSON.stringify({Schema: 'peer', Addrs: addrs, ID: peerId, Protocols: ['transport-bitswap']})

afterEach(() => {
  Date.now = DateNow
})

describe('compact schema', () => {
  it('stores cids as raw bytes and peers as integer references', () => {
    const file = tmpDbFile()
    const store = new ProvidersStore(file)
    store.set(cids[0], entry('peer1', ['/ip4/1.2.3.4/tcp/4001'], 100_000))

    const inspect = new DatabaseSync(file)
    const row = inspect.prepare('SELECT typeof(cid) AS cidType, typeof(peerNumber) AS peerType, cid, lastModified FROM cidProviders').get() as {cidType: string; peerType: string; cid: Uint8Array; lastModified: number}
    expect(row.cidType).toBe('blob')
    expect(row.peerType).toBe('integer')
    // the blob is the raw cid, not utf8 of the base32 string
    expect(CID.decode(row.cid).toString()).toBe(cids[0])
    expect(row.cid.length).toBeLessThan(cids[0].length)
    // timestamps are stored with second precision
    expect(row.lastModified).toBe(100)
    inspect.close()
  })

  it('round-trips providers through the millisecond api', () => {
    const store = new ProvidersStore(tmpDbFile())
    store.set(cids[0], entry('peer1', ['/ip4/1.2.3.4/tcp/4001'], 123_456_789))

    const value = store.get(cids[0])!
    // second-truncated, still expressed in ms
    expect(value.providers['peer1'].lastModified).toBe(123_456_000)
    expect(value.lastModified).toBe(123_456_000)
    expect(value.providers['peer1'].provider.Addrs).toEqual(['/ip4/1.2.3.4/tcp/4001'])
  })

  it('an older entry cannot regress the shared peer record across seconds', () => {
    const store = new ProvidersStore(tmpDbFile())
    store.set(cids[0], entry('peer1', ['/ip4/5.6.7.8/tcp/4001'], 200_000))
    store.set(cids[1], entry('peer1', ['/ip4/1.2.3.4/tcp/4001'], 100_000))

    expect(store.get(cids[0])!.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])
    expect(store.get(cids[1])!.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])
  })

  it('sweep deletes expired announcements and their peers', async () => {
    const file = tmpDbFile()
    const store = new ProvidersStore(file)
    store.set(cids[0], entry('peer1', ['/ip4/1.2.3.4/tcp/4001'], Date.now()))
    expect(store.counts()).toEqual({peers: 1, cidProviders: 1})

    const in10Years = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10
    Date.now = () => in10Years

    await store.sweep()
    expect(store.counts()).toEqual({peers: 0, cidProviders: 0})
  })
})

describe('denormalized schema migration', () => {
  const seedDenormalizedRows = (db: DatabaseSync): void => {
    const insertPeer = db.prepare('INSERT INTO peers (id, provider, lastModified) VALUES (?, ?, ?)')
    const insertCidProvider = db.prepare('INSERT INTO cidProviders (cid, peerId, lastModified) VALUES (?, ?, ?)')
    insertPeer.run('peer1', providerJson('peer1', ['/ip4/5.6.7.8/tcp/4001']), 200_000)
    insertPeer.run('peer2', providerJson('peer2', ['/ip4/9.9.9.9/tcp/4001']), 150_000)
    insertCidProvider.run(cids[0], 'peer1', 100_000)
    insertCidProvider.run(cids[0], 'peer2', 150_000)
    insertCidProvider.run(cids[1], 'peer1', 200_000)
  }

  it('migrates the text-cid millisecond schema in place on startup', () => {
    const file = tmpDbFile()
    const denormalizedDb = createDenormalizedDb(file)
    seedDenormalizedRows(denormalizedDb)
    denormalizedDb.close()

    const store = new ProvidersStore(file)
    expect(store.counts()).toEqual({peers: 2, cidProviders: 3})

    const cid0 = store.get(cids[0])!
    expect(Object.keys(cid0.providers).sort()).toEqual(['peer1', 'peer2'])
    expect(cid0.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])
    // millisecond timestamps were converted to seconds
    expect(cid0.providers['peer1'].lastModified).toBe(100_000)
    expect(cid0.lastModified).toBe(150_000)
    expect(store.get(cids[1])!.providers['peer1'].provider.Addrs).toEqual(['/ip4/5.6.7.8/tcp/4001'])

    // the migrated table holds blob cids
    const inspect = new DatabaseSync(file)
    const cidType = inspect.prepare("SELECT type FROM pragma_table_info('cidProviders') WHERE name = 'cid'").get() as {type: string}
    expect(cidType.type).toBe('BLOB')
    inspect.close()
  })

  it('skips announcements whose peer record is missing instead of crashing', () => {
    const file = tmpDbFile()
    const denormalizedDb = createDenormalizedDb(file)
    seedDenormalizedRows(denormalizedDb)
    // a dangling row, e.g. from a crash between the two sweep passes
    denormalizedDb.prepare('INSERT INTO cidProviders (cid, peerId, lastModified) VALUES (?, ?, ?)').run(cids[2], 'peerGone', 100_000)
    denormalizedDb.close()

    const store = new ProvidersStore(file)
    expect(store.counts()).toEqual({peers: 2, cidProviders: 3})
    expect(store.get(cids[2])).toBe(undefined)
  })

  it('does not run the migration again and preserves later writes on reopen', () => {
    const file = tmpDbFile()
    const denormalizedDb = createDenormalizedDb(file)
    seedDenormalizedRows(denormalizedDb)
    denormalizedDb.close()

    let store = new ProvidersStore(file)
    store.set(cids[2], entry('peer3', ['/ip4/2.2.2.2/tcp/4001'], 300_000))

    store = new ProvidersStore(file)
    expect(store.counts()).toEqual({peers: 3, cidProviders: 4})
    expect(store.get(cids[2])!.providers['peer3'].provider.Addrs).toEqual(['/ip4/2.2.2.2/tcp/4001'])
  })

  it('migration shrinks the file to less than 60% of the denormalized size', () => {
    const file = tmpDbFile()
    const denormalizedDb = createDenormalizedDb(file)
    const insertPeer = denormalizedDb.prepare('INSERT INTO peers (id, provider, lastModified) VALUES (?, ?, ?)')
    const insertCidProvider = denormalizedDb.prepare('INSERT INTO cidProviders (cid, peerId, lastModified) VALUES (?, ?, ?)')
    // like production: a couple of peers with real-size ids each announcing many cids,
    // with realistic millisecond timestamps
    const peerIds = ['12D3KooWPKq3WcCEUvVFaRSnDR1BaaFFp22rUqmNYTWfSRiwWonA', '12D3KooWLNoZZe8n3UtsvRUcRPa4gmWLZsb5mF9Auns9NBhKXV9x']
    for (const peerId of peerIds) {
      insertPeer.run(peerId, providerJson(peerId, ['/ip4/1.2.3.4/tcp/4001']), 1_783_759_795_867)
    }
    denormalizedDb.exec('BEGIN')
    for (let i = 0; i < 20_000; i++) {
      insertCidProvider.run(makeCid(i), peerIds[i % 2], 1_783_759_795_867 + i)
    }
    denormalizedDb.exec('COMMIT')
    denormalizedDb.close()
    const denormalizedSize = fs.statSync(file).size

    const store = new ProvidersStore(file)
    expect(store.counts()).toEqual({peers: 2, cidProviders: 20_000})

    const migratedSize = fs.statSync(file).size
    expect(migratedSize).toBeLessThan(denormalizedSize * 0.6)
  })
})

describe('legacy providers table migration into the compact schema', () => {
  // the pre-normalization production schema: one row per cid with every provider record
  // copied into a json blob
  const createLegacyDb = (file: string): DatabaseSync => {
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE providers (key TEXT PRIMARY KEY, value TEXT NOT NULL, lastModified INTEGER NOT NULL DEFAULT 0) STRICT')
    return db
  }

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

  // more legacy rows than one migration batch, like the old production store where a
  // couple of peers were copied into over a million cid rows. exercises the keyed
  // pagination across batch boundaries and the newest-record-wins guard when the same
  // peer appears with different snapshots throughout the table.
  it('migrates a store larger than one migration batch', () => {
    const rowCount = 12_000 // migration batch size is 10k
    const peer2Every = 4
    const file = tmpDbFile()
    const legacyDb = createLegacyDb(file)
    const insert = legacyDb.prepare('INSERT INTO providers (key, value) VALUES (?, ?)')
    let newestAddrs: string[] = []
    legacyDb.exec('BEGIN')
    for (let i = 0; i < rowCount; i++) {
      // each row carries its own snapshot of peer1's addrs; only the newest may win,
      // regardless of the key order the migration reads them in
      const addrs = [`/ip4/1.2.3.${i % 256}/tcp/${1000 + i}`]
      const providers: Record<string, {addrs: string[]; lastModified: number}> = {
        peer1: {addrs, lastModified: 100_000 + i * 1000}
      }
      if (i === rowCount - 1) {
        newestAddrs = addrs
      }
      if (i % peer2Every === 0) {
        providers['peer2'] = {addrs: ['/ip4/9.9.9.9/tcp/4001'], lastModified: 500_000}
      }
      insert.run(makeCid(i), legacyValue(providers))
    }
    legacyDb.exec('COMMIT')
    legacyDb.close()
    const legacySize = fs.statSync(file).size

    const store = new ProvidersStore(file)

    expect(store.counts()).toEqual({peers: 2, cidProviders: rowCount + rowCount / peer2Every})
    // every cid resolves, and peer1's shared record is the newest snapshot everywhere
    for (const i of [0, 1, 9_999, 10_000, rowCount - 1]) {
      const value = store.get(makeCid(i))!
      expect(value.providers['peer1'].provider.Addrs).toEqual(newestAddrs)
      expect(value.providers['peer1'].lastModified).toBe(100_000 + i * 1000)
      if (i % peer2Every === 0) {
        expect(value.providers['peer2'].provider.Addrs).toEqual(['/ip4/9.9.9.9/tcp/4001'])
      }
    }

    // the duplicated json records collapsed into the compact tables
    const migratedSize = fs.statSync(file).size
    expect(migratedSize).toBeLessThan(legacySize / 2)

    const inspect = new DatabaseSync(file)
    const cidType = inspect.prepare("SELECT type FROM pragma_table_info('cidProviders') WHERE name = 'cid'").get() as {type: string}
    expect(cidType.type).toBe('BLOB')
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'").get()).toBe(undefined)
    inspect.close()
  })

  it('drops rows whose key is not a parseable cid and keeps the rest', () => {
    const file = tmpDbFile()
    const legacyDb = createLegacyDb(file)
    const insert = legacyDb.prepare('INSERT INTO providers (key, value) VALUES (?, ?)')
    insert.run(cids[0], legacyValue({peer1: {addrs: ['/ip4/1.2.3.4/tcp/4001'], lastModified: 100_000}}))
    insert.run('not-a-cid', legacyValue({peer1: {addrs: ['/ip4/1.2.3.4/tcp/4001'], lastModified: 100_000}}))
    insert.run(cids[1], 'not json either')
    legacyDb.close()

    const store = new ProvidersStore(file)
    expect(store.counts()).toEqual({peers: 1, cidProviders: 1})
    expect(store.get(cids[0])!.providers['peer1'].provider.Addrs).toEqual(['/ip4/1.2.3.4/tcp/4001'])
  })
})
