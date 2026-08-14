import express, {type Request, type Response} from 'express'
import Debug from 'debug'
import database from '../lib/database.js'
import {cleanAddrs, logPostProviders, normalizeCid} from '../lib/utils.js'
import {extractRawPayloads} from '../lib/raw-json.js'
import {verificationEnabled, verifyProvider} from '../lib/signature.js'
import prometheus from '../lib/prometheus.js'
import type {Provider, RawBodyRequest} from '../lib/types.js'

const router = express.Router()
const debug = Debug('pkc-http-router:routes:providers')

interface PutProvidersBody {
  Providers: Provider[]
}

router.put('/', async (req: Request, res: Response) => {
  prometheus.postProviders()
  logPostProviders(req)

  // TODO: don't let people add ip addresses that aren't theirs, or peers without any Addrs, or private ips Addrs
  /* TODO: once the POST spec is finalized, add interval and min interval to response, and remove peers after this time
    The Pirate Bay: Often uses an announce interval of 1800 seconds (30 minutes).
    1337x: May use similar intervals like 1800 seconds, with a minimum announce interval of around 300 seconds.
    Rutracker: Frequently employs announce intervals of 1800 seconds, and minimum intervals of around 300-600 seconds.
  */

  const body = req.body as PutProvidersBody
  const reqIp = req.ip ?? ''

  // a malformed body is the client's error: 400, not an unhandled throw that returns
  // express's default 500 page with a stack trace
  if (!Array.isArray(body?.Providers)) {
    res.status(400).set('Content-Type', 'application/json').send({Error: 'invalid body, expected {"Providers": [...]}'})
    return
  }
  for (const provider of body.Providers) {
    if (!provider || typeof provider !== 'object' || !provider.Payload || typeof provider.Payload !== 'object') {
      res.status(400).set('Content-Type', 'application/json').send({Error: 'invalid provider, expected {"Payload": {...}}'})
      return
    }
  }

  // verify signatures before anything is stored: without this, anyone can publish addrs
  // under someone else's peer id and keep that peer unreachable, see lib/signature.ts.
  // unlike the reference server, which stops at the first failing record and keeps the
  // ones it already stored, the whole request is rejected and nothing is stored
  if (verificationEnabled()) {
    const rawPayloads = extractRawPayloads((req as RawBodyRequest).rawBody ?? Buffer.alloc(0))
    for (const [index, provider] of body.Providers.entries()) {
      const {valid, reason, error} = verifyProvider(provider, rawPayloads[index])
      if (!valid) {
        prometheus.postProvidersRejected(reason ?? 'unknown')
        debug('rejected provider', provider.Payload?.ID, reason, error)
        res.status(403).set('Content-Type', 'application/json').send({Error: `record verification failed: ${error}`})
        return
      }
    }
  }

  // validate ip before adding to db
  const providers: Provider[] = []
  try {
    for (const provider of body.Providers) {
      provider.Payload.Addrs = cleanAddrs(provider.Payload.Addrs, reqIp)
      // an unparseable key would otherwise throw inside addProviders and be reported as a 503
      for (const key of provider.Payload.Keys || []) {
        normalizeCid(key)
      }
      if (provider.Payload.Addrs.length) {
        providers.push(provider)
      }
    }
  } catch (e) {
    res.status(400).set('Content-Type', 'application/json').send({Error: (e as Error).message})
    return
  }

  prometheus.postProvidersProviders(providers)

  if (!providers.length) {
    debug('no providers with valid addresses')
  }

  try {
    await database.addProviders(providers)
  } catch (e) {
    // without this, a thrown write (e.g. "database is locked") leaves the request hanging with no
    // response, so the client sees a network timeout and silently drops the announcement. return a
    // real 503 so the client can retry instead.
    debug('failed to add providers', e)
    res.status(503).set('Content-Type', 'application/json').send({Error: (e as Error).message})
    return
  }

  const resBody = {ProvideResults: [] as {Schema: string; Protocol: string; AdvisoryTTL?: number}[]}
  for (const provider of body.Providers) {
    resBody.ProvideResults.push({
      Schema: provider.Schema,
      Protocol: provider.Protocol,
      AdvisoryTTL: provider.Payload.AdvisoryTTL
    })
  }

  res.set('Content-Type', 'application/json')
  res.send(resBody)

  prometheus.postProvidersSuccess()
})

router.get('/:cid', async (req: Request, res: Response) => {
  prometheus.getProviders()

  // a non-cid path is the client's error: 400, not an unhandled throw that returns
  // express's default 500 page with a stack trace
  let cid: string
  try {
    cid = normalizeCid(String(req.params.cid))
  } catch {
    res.writeHead(400, {'Content-Type': 'application/json'})
    res.end(JSON.stringify({Error: `invalid cid '${req.params.cid}'`}))
    return
  }

  const {providers, lastModified} = await database.getProviders(cid)

  prometheus.getProvidersProviders(providers)

  const resBody = JSON.stringify({Providers: providers.length ? providers : null})
  let resStatus = 200
  const resHeaders: Record<string, string | number> = {
    // TODO: add support for application/x-ndjson (streaming)
    'Content-Type': 'application/json',
    'Vary': 'Accept',
    'Content-Length': Buffer.byteLength(resBody)
  }

  // cache-control
  // if server is down, serve cached providers for 24h
  const staleIfError = 60 * 60 * 24
  // 1 minute if has results
  let maxAge = 60
  // 10 seconds if no results
  if (!providers.length) {
    maxAge = 10
    resStatus = 404
  }
  resHeaders['Cache-Control'] = `public, max-age=${maxAge}, public, stale-if-error=${staleIfError}`

  if (lastModified) {
    resHeaders['Last-Modified'] = new Date(lastModified).toUTCString()
  }

  // use res.writeHead() instead of res.set() to force remove content-type charset=utf-8
  res.writeHead(resStatus, resHeaders)
  res.end(resBody)

  prometheus.getProvidersSuccess()
})

export default router
