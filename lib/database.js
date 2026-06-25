import Keyv from 'keyv'
import KeyvSqlite from '@keyv/sqlite'
import fs from 'fs'
import assert from 'assert'
import {randomizeArray} from './utils.js'
import Debug from 'debug'
const debug = Debug('pkc-http-router:routes:providers')
import {CID} from 'multiformats/cid'
import {removeDuplicates, normalizeCid} from './utils.js'

import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const databaseFolderPath = path.join(__dirname, '..', 'data')
const databasePath = path.join(databaseFolderPath, 'database.sqlite')

// TODO: once POST providers specs is finalized, use a shorter time like 30min, more similar to torren trackers
const ttl = 1000 * 60 * 60 * 24

let providersKeyv

const initDatabase = async () => {
  if (providersKeyv) {
    return
  }
  try {
    fs.mkdirSync(databaseFolderPath)
  }
  catch (e) {}

  providersKeyv = new Keyv({
    namespace: 'providers',
    store: new KeyvSqlite(`sqlite://${databasePath}`), 
  })
}

const addProviders = async (providers) => {
  await initDatabase()

  const cids = {}
  for (const provider of providers) {
    // TODO: when deletated routing post spec is finalized, verify signature here

    for (const key of removeDuplicates(provider.Payload.Keys)) {
      // always use the same cid version/codex/encoding
      const cid = normalizeCid(key)

      if (!cids[cid]) {
        cids[cid] = []
      }
      cids[cid].push(provider)
    }
  }

  // add providers to db for each cid
  const promises = []
  for (let cid in cids) {
    promises.push(addCidProvidersToDatabase(cid, cids[cid])) 
  }
  await Promise.all(promises)
}

const addCidProvidersToDatabasePending = {}
const addCidProvidersToDatabase = async (cid, newProviders) => {
  assert(cid && typeof cid === 'string', `database.addCidProvidersToDatabase cid '${cid}' not a string`)
  assert(Array.isArray(newProviders), `database.addCidProvidersToDatabase cid '${cid}' newProviders '${newProviders}' not an array`)

  // don't update the same cid at the same time or could lose data
  while (addCidProvidersToDatabasePending[cid]) {
    await new Promise(r => setTimeout(r, 5))
  }
  addCidProvidersToDatabasePending[cid] = true

  const {providers: nextProviders} = await providersKeyv.get(cid) || {providers: {}}

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
  const nextValue = {
    providers: nextProviders,
    lastModified: Date.now()
  }
  await providersKeyv.set(cid, nextValue)

  delete addCidProvidersToDatabasePending[cid]

  debug('added providers', cid, newProviders)
}

const getProviders = async (cid) => {
  assert(cid && typeof cid === 'string', `database.getProviders cid '${cid}' not a string`)

  // always use the same cid version/codec/encoding
  cid = normalizeCid(cid)

  await initDatabase()

  const {providers: providersObject, lastModified} = await providersKeyv.get(cid) || {providers: {}}

  let providers = Object.values(providersObject)
  // remove expired
  const expiryDate = Date.now() - ttl
  providers = providers.filter(provider => provider.lastModified > expiryDate)
  // randomize array so different peers connect to each other like torrent trackers https://wiki.theory.org/BitTorrentSpecification
  providers = randomizeArray(providers)
  // only return 100 in non streaming response
  if (providers.length > 100) {
    providers.length = 100
  }
  // remove non provider props
  providers = providers.map(provider => provider.provider)

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
  clear: () => providersKeyv.clear(),
  memory: () => {
    providersKeyv = new Keyv({
      namespace: 'providers',
      store: new KeyvSqlite('sqlite://:memory:')
    })
  },

  // private
  _private: {
    addCidProvidersToDatabase,
    providersKeyv: () => providersKeyv
  }
}

export default database
