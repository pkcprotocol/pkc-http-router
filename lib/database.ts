import {DatabaseSync, type StatementSync} from 'node:sqlite'
import fs from 'node:fs'
import assert from 'node:assert'
import path from 'node:path'
import Debug from 'debug'
import {randomizeArray, removeDuplicates, normalizeCid} from './utils.js'
import type {Provider, StoredProvider, CidProviders, GetProvidersResult} from './types.js'

const debug = Debug('pkc-http-router:routes:providers')

const databaseFolderPath = path.join(process.cwd(), 'data')
const databasePath = path.join(databaseFolderPath, 'database.sqlite')

// TODO: once POST providers specs is finalized, use a shorter time like 30min, more similar to torren trackers
const ttl = 1000 * 60 * 60 * 24

// how often the background sweep physically deletes fully expired cid rows
const sweepInterval = 1000 * 60 * 60

// minimal key/value store backed by the built-in node:sqlite module (no native deps).
// values are JSON serialized, keyed by normalized cid string.
class ProvidersStore {
  #db: DatabaseSync
  #getStatement: StatementSync
  #setStatement: StatementSync
  #clearStatement: StatementSync
  #sweepStatement: StatementSync

  constructor(location: string) {
    this.#db = new DatabaseSync(location)
    this.#db.exec('CREATE TABLE IF NOT EXISTS providers (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    this.#getStatement = this.#db.prepare('SELECT value FROM providers WHERE key = ?')
    this.#setStatement = this.#db.prepare('INSERT INTO providers (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    this.#clearStatement = this.#db.prepare('DELETE FROM providers')
    // a row's lastModified is bumped to Date.now() on every write, so a stale row-level
    // lastModified means every provider in it is also expired, safe to delete the whole row
    this.#sweepStatement = this.#db.prepare("DELETE FROM providers WHERE CAST(json_extract(value, '$.lastModified') AS INTEGER) < ?")
  }

  get(key: string): CidProviders | undefined {
    const row = this.#getStatement.get(key) as {value: string} | undefined
    return row ? (JSON.parse(row.value) as CidProviders) : undefined
  }

  set(key: string, value: CidProviders): void {
    this.#setStatement.run(key, JSON.stringify(value))
  }

  clear(): void {
    this.#clearStatement.run()
  }

  // physically delete cid rows whose providers are all expired, so rows for cids that
  // are never re-announced don't accumulate forever (read/write paths only filter/clean
  // the cid currently being touched)
  sweep(): void {
    this.#sweepStatement.run(Date.now() - ttl)
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
  providersStore.sweep()
  const sweepTimer = setInterval(() => providersStore?.sweep(), sweepInterval)
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

  delete addCidProvidersToDatabasePending[cid]

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
    sweep: () => providersStore?.sweep()
  }
}

export default database
