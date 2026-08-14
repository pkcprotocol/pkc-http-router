import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest'
import database from '../../lib/database.js'
import {request, closeServer} from '../helpers/request.js'
import {createTestPeer, signPayload, signedBodyJson, signedProviderJson, providersBodyJson} from '../helpers/sign.js'

// ROOT CAUSE: PUT /routing/v1/providers/ stored every record it received without ever
// looking at Payload.Signature, so anyone could publish addrs under someone else's peer
// id. because a peer's addrs are stored once and shared by all the cids it announces
// (lib/database.ts `peers` table), a single forged record replaced the real peer's addrs
// everywhere, which lets an attacker keep a peer unreachable indefinitely.
// FIX: verify the ipip-0526 signature over the raw Payload bytes before storing anything,
// and reject the request with 403 when it doesn't verify.

const cid = 'bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e'
const victimIp = '123.123.123.123'
const attackerIp = '111.111.111.111'

const headersFor = (ip: string): Record<string, string> => ({
  'user-agent': 'kubo/0.43.0/',
  'content-type': 'application/json',
  'x-forwarded-for': ip
})

const payloadFor = (peerId: string, ip: string, timestamp = Date.now()): object => ({
  Keys: [cid],
  Timestamp: timestamp,
  AdvisoryTTL: 86400000000000,
  ID: peerId,
  Addrs: [`/ip4/${ip}/tcp/4001`, `/ip4/${ip}/udp/4001/quic-v1`]
})

const victim = createTestPeer()
const attacker = createTestPeer()

describe('routes providers signature verification', () => {
  beforeAll(() => {
    database.memory()
    database.clear()
  })
  afterAll(async () => {
    database.clear()
    await closeServer()
  })
  beforeEach(() => {
    database.clear()
  })

  const announceVictim = async (): Promise<void> => {
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(victimIp),
      body: signedBodyJson(victim, payloadFor(victim.peerId, victimIp))
    })
    expect(res.status).toBe(200)
  }

  it('accepts a correctly signed record', async () => {
    await announceVictim()
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(1)
    expect(providers[0].ID).toBe(victim.peerId)
    expect(providers[0].Addrs).toEqual([`/ip4/${victimIp}/tcp/4001`, `/ip4/${victimIp}/udp/4001/quic-v1`])
  })

  it('rejects an unsigned record and keeps the real addrs', async () => {
    await announceVictim()
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(attackerIp),
      // the attacker claims the victim's peer id with addrs pointing at its own ip, which
      // passes the request-ip check because the attacker really is at that ip
      body: signedBodyJson(attacker, payloadFor(victim.peerId, attackerIp), {signature: null})
    })
    expect(res.status).toBe(403)
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(1)
    expect(providers[0].Addrs).toEqual([`/ip4/${victimIp}/tcp/4001`, `/ip4/${victimIp}/udp/4001/quic-v1`])
  })

  it('rejects a record signed by a different peer and keeps the real addrs', async () => {
    await announceVictim()
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(attackerIp),
      // signed with the attacker's key, but claiming the victim's peer id
      body: signedBodyJson(attacker, payloadFor(victim.peerId, attackerIp))
    })
    expect(res.status).toBe(403)
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(1)
    expect(providers[0].Addrs).toEqual([`/ip4/${victimIp}/tcp/4001`, `/ip4/${victimIp}/udp/4001/quic-v1`])
  })

  it('rejects a payload tampered with after signing', async () => {
    const payload = payloadFor(victim.peerId, victimIp)
    const signature = signPayload(victim, JSON.stringify(payload))
    const tampered = {...payload, Addrs: [`/ip4/${attackerIp}/tcp/4001`]}
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(attackerIp),
      body: signedBodyJson(victim, tampered, {signature})
    })
    expect(res.status).toBe(403)
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(0)
  })

  it('rejects a garbage signature', async () => {
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(victimIp),
      body: signedBodyJson(victim, payloadFor(victim.peerId, victimIp), {signature: 'mnotasignature'})
    })
    expect(res.status).toBe(403)
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(0)
  })

  // the signature covers the payload bytes as sent, not a re-serialization of them: a
  // client is free to emit whitespace or a different key order as long as it signs what
  // it sends
  it('accepts a signed payload that json.stringify would not reproduce', async () => {
    const payloadJson = `{\n  "ID": ${JSON.stringify(victim.peerId)},\n  "Addrs": [${JSON.stringify(`/ip4/${victimIp}/tcp/4001`)}],\n  "Keys": [${JSON.stringify(cid)}],\n  "Timestamp": ${Date.now()},\n  "AdvisoryTTL": 86400000000000\n}`
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(victimIp),
      body: signedBodyJson(victim, payloadJson)
    })
    expect(res.status).toBe(200)
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(1)
  })

  // json.parse keeps the last of two duplicate keys, so a verifier that reads the first
  // Payload would check a signed payload while the router stores a different, unsigned one
  it('rejects a record with a duplicate Payload key', async () => {
    const signedPayload = JSON.stringify(payloadFor(victim.peerId, victimIp))
    const forgedPayload = JSON.stringify(payloadFor(victim.peerId, attackerIp))
    const signature = signPayload(victim, signedPayload)
    const providerJson = `{"Schema":"bitswap","Protocol":"transport-bitswap","Signature":${JSON.stringify(signature)},"Payload":${signedPayload},"Payload":${forgedPayload}}`
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(attackerIp),
      body: providersBodyJson([providerJson])
    })
    expect(res.status).toBe(403)
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(0)
  })

  it('rejects the whole request when one record of several fails', async () => {
    const good = signedProviderJson(victim, payloadFor(victim.peerId, victimIp))
    const bad = signedProviderJson(attacker, payloadFor(attacker.peerId, victimIp), {signature: null})
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(victimIp),
      body: providersBodyJson([good, bad])
    })
    expect(res.status).toBe(403)
    // nothing is stored, not even the record that verified
    const {providers} = await database.getProviders(cid)
    expect(providers.length).toBe(0)
  })

  it('rejects a peer id that does not embed a public key', async () => {
    // a sha256 peer id (rsa/ecdsa keys), the public key cannot be extracted from it
    const rsaPeerId = 'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N'
    const res = await request('PUT', '/routing/v1/providers/', {
      headers: headersFor(victimIp),
      body: signedBodyJson(victim, payloadFor(rsaPeerId, victimIp))
    })
    expect(res.status).toBe(403)
  })

  describe('replay protection', () => {
    it('rejects a stale record', async () => {
      const staleTimestamp = Date.now() - 1000 * 60 * 60 * 25
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(victimIp),
        body: signedBodyJson(victim, payloadFor(victim.peerId, victimIp, staleTimestamp))
      })
      expect(res.status).toBe(403)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(0)
    })

    it('rejects a record from too far in the future', async () => {
      const futureTimestamp = Date.now() + 1000 * 60 * 90
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(victimIp),
        body: signedBodyJson(victim, payloadFor(victim.peerId, victimIp, futureTimestamp))
      })
      expect(res.status).toBe(403)
    })

    it('accepts a record inside the window', async () => {
      const recentTimestamp = Date.now() - 1000 * 60 * 60 * 23
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(victimIp),
        body: signedBodyJson(victim, payloadFor(victim.peerId, victimIp, recentTimestamp))
      })
      expect(res.status).toBe(200)
    })

    it('rejects a record without a Timestamp', async () => {
      const {Timestamp, ...payload} = payloadFor(victim.peerId, victimIp) as {Timestamp: number}
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(victimIp),
        body: signedBodyJson(victim, payload)
      })
      expect(res.status).toBe(403)
    })
  })

  describe('VERIFY_SIGNATURES=0 kill switch', () => {
    beforeAll(() => {
      process.env.VERIFY_SIGNATURES = '0'
    })
    afterAll(() => {
      delete process.env.VERIFY_SIGNATURES
    })

    it('accepts an unsigned record', async () => {
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(attackerIp),
        body: signedBodyJson(attacker, payloadFor(victim.peerId, attackerIp), {signature: null})
      })
      expect(res.status).toBe(200)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(1)
    })
  })
})
