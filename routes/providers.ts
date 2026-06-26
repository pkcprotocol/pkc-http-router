import express, {type Request, type Response} from 'express'
import Debug from 'debug'
import database from '../lib/database.js'
import {cleanAddrs, logPostProviders} from '../lib/utils.js'
import prometheus from '../lib/prometheus.js'
import type {Provider} from '../lib/types.js'

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

  // validate ip before adding to db
  const providers: Provider[] = []
  for (const provider of body.Providers) {
    provider.Payload.Addrs = cleanAddrs(provider.Payload.Addrs, reqIp)
    if (provider.Payload.Addrs.length) {
      providers.push(provider)
    }
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

  const {providers, lastModified} = await database.getProviders(String(req.params.cid))

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
