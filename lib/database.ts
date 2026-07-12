import {DatabaseSync, type StatementSync} from 'node:sqlite'
import fs from 'node:fs'
import assert from 'node:assert'
import path from 'node:path'
import Debug from 'debug'
import {randomizeArray, removeDuplicates, normalizeCid} from './utils.js'
import type {Provider, StoredProvider, PeerProvider, CidProviders, GetProvidersResult} from './types.js'

const debug = Debug('pkc-http-router:routes:providers')

const databaseFolderPath = path.join(process.cwd(), 'data')
const databasePath = path.join(databaseFolderPath, 'database.sqlite')

// TODO: once POST providers specs is finalized, use a shorter time like 30min, more similar to torren trackers
const ttl = 1000 * 60 * 60 * 24

// how often the background sweep physically deletes fully expired rows
const sweepInterval = 1000 * 60 * 60

// the sweep deletes expired rows in bounded batches, yielding to the event loop between
// each one, so a single delete transaction never holds the write lock (or blocks the
// synchronous event loop) for long no matter how many rows have expired
const sweepBatchSize = 1000

// minimal normalized store backed by the built-in node:sqlite module (no native deps).
// a peer's provider record (addrs, protocols) is stored once in `peers` and each
// announcement is a tiny (cid, peerId) row in `cidProviders`. before normalization the
// full ~1kb provider record was copied into every cid row, which grew the database to
// gigabytes when a single peer announced over a million cids.
class ProvidersStore {
  #db: DatabaseSync
  #getStatement: StatementSync
  #deleteCidStatement: StatementSync
  #insertCidProviderStatement: StatementSync
  #upsertPeerStatement: StatementSync
  #clearCidProvidersStatement: StatementSync
  #clearPeersStatement: StatementSync
  #sweepCidProvidersStatement: StatementSync
  #sweepPeersStatement: StatementSync
  #countsStatement: StatementSync

  constructor(location: string) {
    this.#db = new DatabaseSync(location)
    // busy_timeout: wait up to 5s for the lock instead of throwing "database is locked" immediately.
    // node:sqlite is synchronous so our own writes are already serialized; the lock contention comes
    // from any *other* process opening the file (sqlite3 cli, backups, a second container on the volume).
    this.#db.exec('PRAGMA busy_timeout = 5000')
    // WAL: readers don't block the writer (and vice versa), so GET lookups keep serving during writes.
    this.#db.exec('PRAGMA journal_mode = WAL')
    // NORMAL is durable under WAL (only loses a transaction on OS/power crash, not on app crash) and much faster.
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#db.exec('CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, provider TEXT NOT NULL, lastModified INTEGER NOT NULL) STRICT')
    // WITHOUT ROWID: the primary key is the row, so each announcement is stored once in
    // the (cid, peerId) btree instead of a rowid table plus a separate primary key index
    this.#db.exec('CREATE TABLE IF NOT EXISTS cidProviders (cid TEXT NOT NULL, peerId TEXT NOT NULL, lastModified INTEGER NOT NULL, PRIMARY KEY (cid, peerId)) STRICT, WITHOUT ROWID')
    this.#migrateLegacyProvidersTable()
    // lastModified indexes make the sweeps indexed range deletes instead of full scans
    this.#db.exec('CREATE INDEX IF NOT EXISTS cidProviders_lastModified ON cidProviders (lastModified)')
    this.#db.exec('CREATE INDEX IF NOT EXISTS peers_lastModified ON peers (lastModified)')
    this.#getStatement = this.#db.prepare('SELECT cidProviders.peerId AS peerId, cidProviders.lastModified AS lastModified, peers.provider AS provider FROM cidProviders JOIN peers ON peers.id = cidProviders.peerId WHERE cidProviders.cid = ?')
    this.#deleteCidStatement = this.#db.prepare('DELETE FROM cidProviders WHERE cid = ?')
    this.#insertCidProviderStatement = this.#db.prepare('INSERT INTO cidProviders (cid, peerId, lastModified) VALUES (?, ?, ?) ON CONFLICT(cid, peerId) DO UPDATE SET lastModified = excluded.lastModified')
    // the guard keeps the newest record per peer: an entry round-tripped through get()
    // by another cid's write must not regress the peer's shared addrs with older ones
    this.#upsertPeerStatement = this.#db.prepare('INSERT INTO peers (id, provider, lastModified) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, lastModified = excluded.lastModified WHERE excluded.lastModified >= peers.lastModified')
    this.#clearCidProvidersStatement = this.#db.prepare('DELETE FROM cidProviders')
    this.#clearPeersStatement = this.#db.prepare('DELETE FROM peers')
    // delete by primary key from an indexed, bounded subquery so each batch is a quick keyed delete
    this.#sweepCidProvidersStatement = this.#db.prepare('DELETE FROM cidProviders WHERE (cid, peerId) IN (SELECT cid, peerId FROM cidProviders WHERE lastModified < ? LIMIT ?)')
    this.#sweepPeersStatement = this.#db.prepare('DELETE FROM peers WHERE id IN (SELECT id FROM peers WHERE lastModified < ? LIMIT ?)')
    this.#countsStatement = this.#db.prepare('SELECT (SELECT COUNT(*) FROM peers) AS peers, (SELECT COUNT(*) FROM cidProviders) AS cidProviders')
  }

  // one-time, pure sql migration of the pre-normalization schema (one row per cid with
  // every provider record copied into a json blob) into the normalized tables, so old
  // production stores upgrade in place on startup. also handles the oldest schema that
  // had no lastModified column, since only the json value is read. transactional: a
  // crash mid-migration leaves the legacy table intact and it retries on next startup.
  #migrateLegacyProvidersTable(): void {
    const legacyTable = this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'").get()
    if (!legacyTable) {
      return
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      // keep the newest record per peer across all its cid rows ("WHERE true" is required
      // by sqlite to disambiguate the join from the ON CONFLICT clause)
      this.#db.exec(`
        INSERT INTO peers (id, provider, lastModified)
        SELECT entry.key, json_extract(entry.value, '$.provider'), CAST(json_extract(entry.value, '$.lastModified') AS INTEGER)
        FROM providers, json_each(providers.value, '$.providers') AS entry
        WHERE true
        ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, lastModified = excluded.lastModified
        WHERE excluded.lastModified >= peers.lastModified
      `)
      this.#db.exec(`
        INSERT INTO cidProviders (cid, peerId, lastModified)
        SELECT providers.key, entry.key, CAST(json_extract(entry.value, '$.lastModified') AS INTEGER)
        FROM providers, json_each(providers.value, '$.providers') AS entry
        WHERE true
        ON CONFLICT(cid, peerId) DO UPDATE SET lastModified = excluded.lastModified
      `)
      this.#db.exec('DROP TABLE providers')
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    // the legacy table was ~10x the size of the normalized data and sqlite never shrinks
    // the file on its own (freed pages are only reused), so reclaim the space once now.
    // under WAL the vacuumed image lives in the -wal file until a checkpoint, so force
    // one or the main file would stay at its multi-gigabyte size until sqlite gets to it
    this.#db.exec('VACUUM')
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  get(key: string): CidProviders | undefined {
    const rows = this.#getStatement.all(key) as {peerId: string; lastModified: number; provider: string}[]
    if (!rows.length) {
      return undefined
    }
    const providers: Record<string, StoredProvider> = {}
    let lastModified = 0
    for (const row of rows) {
      providers[row.peerId] = {provider: JSON.parse(row.provider) as PeerProvider, lastModified: row.lastModified}
      if (row.lastModified > lastModified) {
        lastModified = row.lastModified
      }
    }
    return {providers, lastModified}
  }

  set(key: string, value: CidProviders): void {
    // replace the cid's announcements and refresh each peer's shared record atomically
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#deleteCidStatement.run(key)
      for (const peerId in value.providers) {
        const {provider, lastModified} = value.providers[peerId]
        this.#upsertPeerStatement.run(peerId, JSON.stringify(provider), lastModified)
        this.#insertCidProviderStatement.run(key, peerId, lastModified)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  clear(): void {
    this.#clearCidProvidersStatement.run()
    this.#clearPeersStatement.run()
  }

  // row counts of the normalized tables, used by tests to assert deduplication
  counts(): {peers: number; cidProviders: number} {
    return this.#countsStatement.get() as {peers: number; cidProviders: number}
  }

  // physically delete announcements past the ttl, so rows for cids that are never
  // re-announced don't accumulate forever (read/write paths only filter/clean the cid
  // currently being touched). deletes in bounded batches, yielding between each, so the
  // write lock / synchronous event-loop block stays short regardless of table size.
  async sweep(): Promise<void> {
    const expiryDate = Date.now() - ttl
    let deleted: number
    do {
      deleted = Number(this.#sweepCidProvidersStatement.run(expiryDate, sweepBatchSize).changes)
      // yield so GET lookups / PUT writes can run between batches
      if (deleted === sweepBatchSize) {
        await new Promise(resolve => setImmediate(resolve))
      }
    } while (deleted === sweepBatchSize)
    // a peer's lastModified is its newest announcement, so an expired peer has no live
    // cidProviders rows left after the pass above; delete its shared record too
    do {
      deleted = Number(this.#sweepPeersStatement.run(expiryDate, sweepBatchSize).changes)
      if (deleted === sweepBatchSize) {
        await new Promise(resolve => setImmediate(resolve))
      }
    } while (deleted === sweepBatchSize)
  }
}

let providersStore: ProvidersStore | undefined

const initDatabase = async (): Promise<void> => {
  if (providersStore) {
    return
  }
  fs.mkdirSync(databaseFolderPath, {recursive: true})
  providersStore = new ProvidersStore(databasePath)

  // sweep stale rows on startup, then periodically; unref so it never keeps the process alive
  providersStore.sweep().catch(error => debug('startup sweep failed', error))
  const sweepTimer = setInterval(() => providersStore?.sweep().catch(error => debug('sweep failed', error)), sweepInterval)
  sweepTimer.unref()
}

const addProviders = async (providers: Provider[]): Promise<void> => {
  await initDatabase()

  const cids: Record<string, Provider[]> = {}
  for (const provider of providers) {
    // TODO: when deletated routing post spec is finalized, verify signature here

    for (const key of removeDuplicates(provider.Payload.Keys || [])) {
      // always use the same cid version/codex/encoding
      const cid = normalizeCid(key)

      if (!cids[cid]) {
        cids[cid] = []
      }
      cids[cid].push(provider)
    }
  }

  // add providers to db for each cid
  const promises: Promise<void>[] = []
  for (const cid in cids) {
    promises.push(addCidProvidersToDatabase(cid, cids[cid]))
  }
  await Promise.all(promises)
}

const addCidProvidersToDatabasePending: Record<string, boolean> = {}
const addCidProvidersToDatabase = async (cid: string, newProviders: Provider[]): Promise<void> => {
  assert(cid && typeof cid === 'string', `database.addCidProvidersToDatabase cid '${cid}' not a string`)
  assert(Array.isArray(newProviders), `database.addCidProvidersToDatabase cid '${cid}' newProviders '${newProviders}' not an array`)

  await initDatabase()

  // don't update the same cid at the same time or could lose data
  while (addCidProvidersToDatabasePending[cid]) {
    await new Promise(r => setTimeout(r, 5))
  }
  addCidProvidersToDatabasePending[cid] = true
  // the pending flag must be cleared even when the read/write throws (e.g. "database is
  // locked" past busy_timeout), otherwise every later write for this cid spins on the
  // pending loop forever and the cid can never be announced again until restart
  try {
    const {providers: nextProviders} = providersStore!.get(cid) || {providers: {} as Record<string, StoredProvider>}

    // remove expired providers to save space, db is self cleaning
    const expiryDate = Date.now() - ttl
    for (const providerId in nextProviders) {
      if (nextProviders[providerId].lastModified < expiryDate) {
        delete nextProviders[providerId]
      }
    }

    for (const newProvider of newProviders) {
      nextProviders[newProvider.Payload.ID] = {
        provider: {
          Schema: 'peer',
          Addrs: newProvider.Payload.Addrs,
          ID: newProvider.Payload.ID,
          Protocols: [newProvider.Protocol]
        },
        lastModified: Date.now()
      }
    }
    const nextValue: CidProviders = {
      providers: nextProviders,
      lastModified: Date.now()
    }
    providersStore!.set(cid, nextValue)
  } finally {
    delete addCidProvidersToDatabasePending[cid]
  }

  debug('added providers', cid, newProviders)
}

const getProviders = async (cidString: string): Promise<GetProvidersResult> => {
  assert(cidString && typeof cidString === 'string', `database.getProviders cid '${cidString}' not a string`)

  // always use the same cid version/codec/encoding
  const cid = normalizeCid(cidString)

  await initDatabase()

  const {providers: providersObject, lastModified} = providersStore!.get(cid) || {providers: {}, lastModified: undefined}

  let storedProviders: StoredProvider[] = Object.values(providersObject)
  // remove expired
  const expiryDate = Date.now() - ttl
  storedProviders = storedProviders.filter(provider => provider.lastModified > expiryDate)
  // randomize array so different peers connect to each other like torrent trackers https://wiki.theory.org/BitTorrentSpecification
  storedProviders = randomizeArray(storedProviders)
  // only return 100 in non streaming response
  if (storedProviders.length > 100) {
    storedProviders.length = 100
  }
  // remove non provider props
  const providers = storedProviders.map(storedProvider => storedProvider.provider)

  return {
    providers,
    lastModified
  }
}

const database = {
  // public
  addProviders,
  getProviders,

  // for testing
  clear: () => providersStore?.clear(),
  memory: () => {
    providersStore = new ProvidersStore(':memory:')
  },

  // private
  _private: {
    addCidProvidersToDatabase,
    providersKeyv: () => providersStore,
    sweep: () => providersStore?.sweep(),
    ProvidersStore
  }
}

export default database
