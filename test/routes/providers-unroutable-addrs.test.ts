import {describe, it, expect, beforeAll, afterAll} from 'vitest'
import database from '../../lib/database.js'
import {request, closeServer} from '../helpers/request.js'
import {createTestPeer, signedBodyJson} from '../helpers/sign.js'

// ROOT CAUSE: production routers (routing.lol, peers.pleb.bot, routerofbitsocial.xyz) ran
// with NO_IP_VALIDATE=1, a testing switch from 2024 that made cleanAddrs return every addr
// unchanged. it skipped the private-ip check along with the strict request-ip check, so
// seeders behind nat or in a vm got records stored with only loopback/private addrs, and
// every client spent dials on addrs nobody outside that machine can reach
// (pkcprotocol/pkc-http-router#7). the private-ip check also missed fec0::/10 (site-local,
// what qemu user networking gives a guest) and 100.64.0.0/10 (carrier-grade nat, which is
// also where tailscale addrs live)
// FIX: dropping unroutable addrs is its own setting, DROP_UNROUTABLE_ADDRS, on by default and
// independent of the strict request-ip check (now the opt-in STRICT_IP_MATCH), and covers
// every special-purpose range nobody on the public internet can dial

const reqIp = '123.123.123.123'
const cid = 'bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e'
const headers = {
  'user-agent': 'kubo/0.43.0/',
  'x-forwarded-for': reqIp
}

// the addrs the issue saw on routing.lol and peers.pleb.bot, plus a tailscale addr
const unroutableAddrs = [
  '/ip4/127.0.0.1/udp/4001/quic-v1/webtransport',
  '/ip6/::1/udp/4001/quic-v1/webtransport',
  '/ip4/10.0.2.15/udp/4001/quic-v1/webtransport',
  '/ip6/fec0::4ba:550:1228:cca/udp/4001/quic-v1/webtransport',
  '/ip4/10.66.85.7/tcp/4001',
  '/ip4/100.101.102.103/tcp/4001'
]

const announce = async (addrs: string[]) => {
  const peer = createTestPeer()
  const payload = {
    Keys: [cid],
    Timestamp: Date.now(),
    AdvisoryTTL: 86400000000000,
    ID: peer.peerId,
    Addrs: addrs
  }
  return request('PUT', '/routing/v1/providers/', {headers, body: signedBodyJson(peer, payload)})
}

describe('routes providers unroutable addrs', () => {
  const previousNoIpValidate = process.env.NO_IP_VALIDATE
  beforeAll(() => {
    database.memory()
    database.clear()
    // what the production routers were running with
    process.env.NO_IP_VALIDATE = '1'
  })
  afterAll(async () => {
    if (previousNoIpValidate === undefined) {
      delete process.env.NO_IP_VALIDATE
    } else {
      process.env.NO_IP_VALIDATE = previousNoIpValidate
    }
    database.clear()
    await closeServer()
  })

  it('does not store a record whose addrs are all unroutable', async () => {
    const res = await announce(unroutableAddrs)
    expect(res.status).toBe(200)
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(0)
  })

  it('stores only the routable addrs of a record that mixes both', async () => {
    database.clear()
    const publicAddr = `/ip4/${reqIp}/tcp/4001`
    await announce([...unroutableAddrs, publicAddr])
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(1)
    expect(providers[0].Addrs).toEqual([publicAddr])
  })
})
