import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest'
import crypto from 'node:crypto'
import {CID} from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
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
const rawCodec = 0x55
const sha256Code = 0x12
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

  // the scanner that locates the signed Payload bytes compares raw key text while JSON.parse
  // unescapes keys, so an escaped second key made them pick different payloads: the
  // signature was checked over a captured record of the victim, of any age, while the
  // Timestamp, Addrs and Keys that got stored came from a payload nobody signed
  describe('stores the payload the signature covers', () => {
    const capturedPayload = (timestamp: number): string => JSON.stringify(payloadFor(victim.peerId, victimIp, timestamp))
    const forgedPayload = JSON.stringify(payloadFor(victim.peerId, attackerIp))
    const providerJsonWith = (signedPayload: string, members: string): string =>
      `{"Schema":"bitswap","Protocol":"transport-bitswap","Signature":${JSON.stringify(signPayload(victim, signedPayload))},"Payload":${signedPayload},${members}}`
    const staleTimestamp = (): number => Date.now() - 1000 * 60 * 60 * 25

    it('rejects a stale signed payload followed by an escaped Payload key', async () => {
      const signedPayload = capturedPayload(staleTimestamp())
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(attackerIp),
        body: providersBodyJson([providerJsonWith(signedPayload, `"\\u0050ayload":${forgedPayload}`)])
      })
      expect(res.status).toBe(403)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(0)
    })

    it('stores the signed addrs, not the ones under an escaped Payload key', async () => {
      const signedPayload = capturedPayload(Date.now() - 1000 * 60)
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(attackerIp),
        body: providersBodyJson([providerJsonWith(signedPayload, `"\\u0050ayload":${forgedPayload}`)])
      })
      expect(res.status).toBe(200)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(1)
      expect(providers[0].Addrs).toEqual([`/ip4/${victimIp}/tcp/4001`, `/ip4/${victimIp}/udp/4001/quic-v1`])
    })

    it('rejects a stale signed record followed by an escaped Providers key', async () => {
      const signedPayload = capturedPayload(staleTimestamp())
      const signature = signPayload(victim, signedPayload)
      const signedProvider = `{"Schema":"bitswap","Protocol":"transport-bitswap","Signature":${JSON.stringify(signature)},"Payload":${signedPayload}}`
      const forgedProvider = `{"Schema":"bitswap","Protocol":"transport-bitswap","Signature":${JSON.stringify(signature)},"Payload":${forgedPayload}}`
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: headersFor(attackerIp),
        body: `{"Providers":[${signedProvider}],"\\u0050roviders":[${forgedProvider}]}`
      })
      expect(res.status).toBe(403)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(0)
    })

    // body-parser decodes any utf-* charset before JSON.parse, while the signature covers
    // the bytes as sent, so the parsed body can differ from the signed bytes without a
    // single backslash: in utf-7, '+AFA-' decodes to 'P' and '+-' to '+'
    it('rejects a stale signed payload whose duplicate key only matches after charset decoding', async () => {
      const signedPayload = capturedPayload(staleTimestamp())
      const providerJson = providerJsonWith(signedPayload, `"+AFA-ayload":${forgedPayload}`)
        .replace(/"Signature":"[^"]*"/, (signatureMember) => signatureMember.replaceAll('+', '+-'))
      const res = await request('PUT', '/routing/v1/providers/', {
        headers: {...headersFor(attackerIp), 'content-type': 'application/json; charset=utf-7'},
        body: providersBodyJson([providerJson])
      })
      expect(res.status).toBe(403)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(0)
    })
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

    // the 24h window alone let anyone holding a peer's earlier record replay it after a
    // newer one, which put the peer's older addrs back on every cid it announces and
    // restarted their ttl. the peer's addrs must only move forward in signed time
    it('keeps the newer addrs when an older record of the peer is replayed', async () => {
      const newIp = '124.124.124.124'
      const olderBody = signedBodyJson(victim, payloadFor(victim.peerId, victimIp, Date.now() - 1000 * 60 * 10))
      const newerBody = signedBodyJson(victim, payloadFor(victim.peerId, newIp, Date.now() - 1000 * 60 * 5))
      expect((await request('PUT', '/routing/v1/providers/', {headers: headersFor(victimIp), body: olderBody})).status).toBe(200)
      expect((await request('PUT', '/routing/v1/providers/', {headers: headersFor(newIp), body: newerBody})).status).toBe(200)

      // still inside the window and signed by the peer, so it is accepted, but it must not
      // put the older addrs back on
      const res = await request('PUT', '/routing/v1/providers/', {headers: headersFor(victimIp), body: olderBody})
      expect(res.status).toBe(200)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(1)
      expect(providers[0].Addrs).toEqual([`/ip4/${newIp}/tcp/4001`, `/ip4/${newIp}/udp/4001/quic-v1`])
    })

    // one request can hold several records of a peer for the same cid. only one of them
    // reaches the store per cid, so an older-signed one later in the request must not be
    // the one that wins over the newer record sent ahead of it
    it('keeps the newer addrs when one request has an older record of the peer after a newer one', async () => {
      const newIp = '124.124.124.124'
      const newer = signedProviderJson(victim, payloadFor(victim.peerId, newIp, Date.now() - 1000 * 60 * 5))
      const older = signedProviderJson(victim, payloadFor(victim.peerId, victimIp, Date.now() - 1000 * 60 * 10))
      const res = await request('PUT', '/routing/v1/providers/', {headers: headersFor(newIp), body: providersBodyJson([newer, older])})
      expect(res.status).toBe(200)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(1)
      expect(providers[0].Addrs).toEqual([`/ip4/${newIp}/tcp/4001`, `/ip4/${newIp}/udp/4001/quic-v1`])
    })

    // Payload.Timestamp is any json number, so two records of a peer can be signed less than
    // 1ms apart. the comparison must still see which one is newer
    it('keeps the newer addrs when an older record signed in the same ms is replayed', async () => {
      const newIp = '124.124.124.124'
      const ms = Math.floor(Date.now() - 1000 * 60)
      const olderBody = signedBodyJson(victim, payloadFor(victim.peerId, victimIp, ms + 0.1))
      const newerBody = signedBodyJson(victim, payloadFor(victim.peerId, newIp, ms + 0.9))
      expect((await request('PUT', '/routing/v1/providers/', {headers: headersFor(newIp), body: newerBody})).status).toBe(200)
      expect((await request('PUT', '/routing/v1/providers/', {headers: headersFor(victimIp), body: olderBody})).status).toBe(200)
      const {providers} = await database.getProviders(cid)
      expect(providers.length).toBe(1)
      expect(providers[0].Addrs).toEqual([`/ip4/${newIp}/tcp/4001`, `/ip4/${newIp}/udp/4001/quic-v1`])
    })

    // kubo (boxo ProvideMany) splits a large provide into batches of keys and sends them
    // concurrently, each signed with its own time, so a batch can arrive after one signed
    // later. every batch is a valid announcement and all of its keys must be stored
    it('stores every record of a peer when later-signed ones arrive first', async () => {
      const now = Date.now()
      const keys = [0, 1, 2, 3, 4].map(i => CID.create(1, rawCodec, Digest.create(sha256Code, crypto.createHash('sha256').update(`batch${i}`).digest())).toString())
      const statuses: number[] = []
      // newest first: each record is signed 1ms before the one sent ahead of it
      for (const [i, key] of keys.entries()) {
        const payload = {...payloadFor(victim.peerId, victimIp, now - i), Keys: [key]}
        const res = await request('PUT', '/routing/v1/providers/', {headers: headersFor(victimIp), body: signedBodyJson(victim, payload)})
        statuses.push(res.status)
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200])
      for (const key of keys) {
        const {providers} = await database.getProviders(key)
        expect(providers.length).toBe(1)
        expect(providers[0].ID).toBe(victim.peerId)
      }
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
})
