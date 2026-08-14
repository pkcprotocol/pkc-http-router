import {describe, it, expect} from 'vitest'
import crypto from 'node:crypto'
import {base58btc} from 'multiformats/bases/base58'
import {verifySignature, verifyTimestamp, verifyProvider, publicKeyFromPeerId} from '../../lib/signature.js'
import type {Provider} from '../../lib/types.js'

// the test fixtures of ipip-0526, a conforming verifier must accept this record
// https://github.com/ipfs/specs/blob/4d13666f1d2915e03e6f8f8f86a710779e826e8a/src/ipips/ipip-0526.md#test-fixtures
const vector = {
  peerId: '12D3KooWKcTtoUYcQVfURdwUZtPsanm97SdEf7DkesyxTz7kkD2z',
  payload: '{"Keys":["bafkreigur6gzxm3ykiol7ywou3iy3obruzs2q7boizj7oznznid34dzc3e"],"Timestamp":1725833163372,"AdvisoryTTL":86400000000000,"ID":"12D3KooWKcTtoUYcQVfURdwUZtPsanm97SdEf7DkesyxTz7kkD2z","Addrs":["/ip4/198.51.100.1/tcp/4001","/ip4/198.51.100.1/udp/4001/quic-v1"]}',
  signature: 'mlGWqELZSoVjY22w6NxT7TuNUj5BmQRlrv/x27jQHo5pM3CYZRlJ834bi0UazFuXlH2SuMBxdwfELdXXwVkjZBQ',
  digest: '198b43ea6aba9071845059c5e91eba3926df35926da35c61c1b7429fd7ffb3b8',
  timestamp: 1725833163372
}

const vectorProvider = (): Provider => ({
  Schema: 'bitswap',
  Protocol: 'transport-bitswap',
  Signature: vector.signature,
  Payload: JSON.parse(vector.payload)
})

const vectorPayloadBytes = Buffer.from(vector.payload, 'utf8')

describe('lib signature', () => {
  describe('ipip-0526 test vector', () => {
    it('hashes the payload to the documented digest', () => {
      expect(crypto.createHash('sha256').update(vectorPayloadBytes).digest('hex')).toBe(vector.digest)
    })

    it('verifies the signed record', () => {
      expect(verifySignature(vectorProvider(), vectorPayloadBytes)).toEqual({valid: true})
    })

    it('verifies with the timestamp check at the time the record was made', () => {
      expect(verifyProvider(vectorProvider(), vectorPayloadBytes, vector.timestamp + 1000)).toEqual({valid: true})
    })

    it('rejects the unsigned version of the record', () => {
      const provider = vectorProvider()
      delete provider.Signature
      expect(verifySignature(provider, vectorPayloadBytes).reason).toBe('missing_signature')
    })

    it('rejects a payload that differs by one byte', () => {
      const tampered = Buffer.from(vector.payload.replace('198.51.100.1', '198.51.100.2'), 'utf8')
      expect(verifySignature(vectorProvider(), tampered).reason).toBe('invalid_signature')
    })

    // reformatting the payload invalidates the signature, which is why the router verifies
    // the raw bytes instead of a re-serialization of the parsed object
    it('rejects a pretty printed copy of the same payload', () => {
      const pretty = Buffer.from(JSON.stringify(JSON.parse(vector.payload), null, 2), 'utf8')
      expect(verifySignature(vectorProvider(), pretty).reason).toBe('invalid_signature')
    })
  })

  // captured from a real `ipfs routing provide` of kubo 0.43.0, the version clients run
  describe('kubo 0.43.0 record', () => {
    const raw = '{"Providers":[{"Schema":"bitswap","Protocol":"transport-bitswap","Signature":"mNxTpGng8J1qdB2spCDypwEVFUOzqUWLNZPvJnF8gk9JXv1hhi/rdml5kHU6lYuJuL7zrzERvB+pbgK7JtYLgBw","Payload":{"Keys":["bafkreieqtoykbmp327n5p7l6ov5aubnbwhvcxcqhoemwiysch7mbtp2x7u"],"Timestamp":1786688966533,"AdvisoryTTL":86400000000000,"ID":"12D3KooWLM51mxUKahfGPHjYRgwCx3VnBUBfRm2g2nA8S3ko2pze","Addrs":[]}}]}'
    const provider = (JSON.parse(raw) as {Providers: Provider[]}).Providers[0]
    const payloadStart = raw.indexOf('{"Keys"')
    const payloadBytes = Buffer.from(raw.slice(payloadStart, raw.length - 3), 'utf8')

    it('verifies', () => {
      expect(verifyProvider(provider, payloadBytes, 1786688966533)).toEqual({valid: true})
    })

    it('does not verify once its Addrs are changed', () => {
      const tamperedRaw = raw.replace('"Addrs":[]', '"Addrs":["/ip4/1.2.3.4/tcp/4001"]')
      const tampered = (JSON.parse(tamperedRaw) as {Providers: Provider[]}).Providers[0]
      const tamperedBytes = Buffer.from(tamperedRaw.slice(tamperedRaw.indexOf('{"Keys"'), tamperedRaw.length - 3), 'utf8')
      expect(verifySignature(tampered, tamperedBytes).reason).toBe('invalid_signature')
    })
  })

  describe('public key extraction', () => {
    it('extracts an ed25519 key from a base58btc peer id', () => {
      expect(publicKeyFromPeerId(vector.peerId).keyObject.asymmetricKeyType).toBe('ed25519')
    })

    it('extracts an ed25519 key from a cidv1 libp2p-key peer id', () => {
      // the same peer id as a cidv1 with the libp2p-key codec, as accepted by ipip-0526
      const cidPeerId = 'bafzaajaiaejcbemil554blls4hqc4jrq6tmmmh4tc2dfm6mu66lbawvvnba3xeul'
      expect(publicKeyFromPeerId(cidPeerId).keyObject.asymmetricKeyType).toBe('ed25519')
    })

    it('throws on a peer id that does not embed a public key', () => {
      // sha256 peer id, as produced by rsa and ecdsa keys
      expect(() => publicKeyFromPeerId('QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N')).toThrow('does not embed a public key')
    })

    it('throws on a peer id that is not a peer id', () => {
      expect(() => publicKeyFromPeerId('not-a-peer-id')).toThrow()
    })
  })

  // secp256k1 peer ids also embed their public key, and libp2p signs with ecdsa, which
  // hashes the message (here already a sha256 digest) again before signing
  describe('secp256k1 records', () => {
    const createSecp256k1Peer = () => {
      const {publicKey, privateKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'secp256k1'})
      const jwk = publicKey.export({format: 'jwk'}) as {x: string; y: string}
      const x = Buffer.from(jwk.x, 'base64url')
      const y = Buffer.from(jwk.y, 'base64url')
      const compressed = Buffer.concat([Buffer.from([(y[y.length - 1] & 1) === 1 ? 0x03 : 0x02]), x])
      // protobuf: field 1 (Type) = 2 (Secp256k1), field 2 (Data) = the compressed point
      const protobuf = Buffer.concat([Buffer.from([0x08, 0x02, 0x12, compressed.length]), compressed])
      const multihash = Buffer.concat([Buffer.from([0x00, protobuf.length]), protobuf])
      return {peerId: base58btc.baseEncode(multihash), privateKey}
    }

    it('verifies a signed record', () => {
      const {peerId, privateKey} = createSecp256k1Peer()
      const payload = JSON.stringify({Keys: [], Timestamp: Date.now(), AdvisoryTTL: 0, ID: peerId, Addrs: []})
      const payloadBytes = Buffer.from(payload, 'utf8')
      const digest = crypto.createHash('sha256').update(payloadBytes).digest()
      const signature = 'm' + crypto.sign('sha256', digest, privateKey).toString('base64').replace(/=+$/, '')
      const provider: Provider = {Schema: 'bitswap', Protocol: 'transport-bitswap', Signature: signature, Payload: JSON.parse(payload)}
      expect(verifySignature(provider, payloadBytes)).toEqual({valid: true})
    })

    it('rejects a record signed by another key', () => {
      const {peerId} = createSecp256k1Peer()
      const other = createSecp256k1Peer()
      const payload = JSON.stringify({Keys: [], Timestamp: Date.now(), AdvisoryTTL: 0, ID: peerId, Addrs: []})
      const payloadBytes = Buffer.from(payload, 'utf8')
      const digest = crypto.createHash('sha256').update(payloadBytes).digest()
      const signature = 'm' + crypto.sign('sha256', digest, other.privateKey).toString('base64').replace(/=+$/, '')
      const provider: Provider = {Schema: 'bitswap', Protocol: 'transport-bitswap', Signature: signature, Payload: JSON.parse(payload)}
      expect(verifySignature(provider, payloadBytes).reason).toBe('invalid_signature')
    })
  })

  describe('multibase', () => {
    it('accepts a signature in another multibase encoding', () => {
      // base64url ('u') instead of the base64 ('m') the reference client uses
      const signature = Buffer.from(vector.signature.slice(1), 'base64')
      const provider = vectorProvider()
      provider.Signature = 'u' + signature.toString('base64url').replace(/=+$/, '')
      expect(verifySignature(provider, vectorPayloadBytes)).toEqual({valid: true})
    })

    it('rejects an unknown multibase prefix', () => {
      const provider = vectorProvider()
      provider.Signature = '!' + vector.signature.slice(1)
      expect(verifySignature(provider, vectorPayloadBytes).reason).toBe('invalid_signature')
    })

    it('rejects a signature of the wrong length', () => {
      const provider = vectorProvider()
      provider.Signature = 'mAAAA'
      expect(verifySignature(provider, vectorPayloadBytes).reason).toBe('invalid_signature')
    })
  })

  describe('timestamp', () => {
    const now = 1760000000000
    const providerWithTimestamp = (Timestamp: unknown): Provider => ({
      Schema: 'bitswap',
      Protocol: 'transport-bitswap',
      Payload: {ID: 'peer', Addrs: [], Timestamp: Timestamp as number}
    })

    it('accepts a fresh timestamp', () => {
      expect(verifyTimestamp(providerWithTimestamp(now - 1000), now)).toEqual({valid: true})
    })

    it('accepts a timestamp just inside the window', () => {
      expect(verifyTimestamp(providerWithTimestamp(now - 1000 * 60 * 60 * 24 + 1000), now)).toEqual({valid: true})
    })

    it('rejects a timestamp just outside the window', () => {
      expect(verifyTimestamp(providerWithTimestamp(now - 1000 * 60 * 60 * 24 - 1000), now).reason).toBe('stale_timestamp')
    })

    it('allows an hour of clock skew', () => {
      expect(verifyTimestamp(providerWithTimestamp(now + 1000 * 60 * 59), now)).toEqual({valid: true})
    })

    it('rejects a timestamp too far in the future', () => {
      expect(verifyTimestamp(providerWithTimestamp(now + 1000 * 60 * 61), now).reason).toBe('future_timestamp')
    })

    it('rejects a missing timestamp', () => {
      expect(verifyTimestamp(providerWithTimestamp(undefined), now).reason).toBe('missing_timestamp')
    })

    it('rejects a non number timestamp', () => {
      expect(verifyTimestamp(providerWithTimestamp('1760000000000'), now).reason).toBe('missing_timestamp')
    })
  })

  describe('missing payload bytes', () => {
    it('rejects a record whose payload bytes could not be located', () => {
      expect(verifySignature(vectorProvider(), undefined).reason).toBe('missing_payload_bytes')
    })
  })
})
