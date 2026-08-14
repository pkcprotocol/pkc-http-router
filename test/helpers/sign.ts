import crypto from 'node:crypto'
import {base58btc} from 'multiformats/bases/base58'

// builds ipip-0526 signed records the way a real client does:
// https://github.com/ipfs/specs/blob/4d13666f1d2915e03e6f8f8f86a710779e826e8a/src/ipips/ipip-0526.md
// the signature covers the Payload bytes exactly as they appear in the request body, so
// these helpers return the request body as a string, never as an object to be
// re-serialized by the test http helper

export interface TestPeer {
  peerId: string
  privateKey: crypto.KeyObject
}

// peer id = base58btc(identity multihash of the protobuf-encoded libp2p public key)
const ed25519PublicKeyProtobufPrefix = Buffer.from([0x08, 0x01, 0x12, 0x20])

export const createTestPeer = (): TestPeer => {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519')
  const jwk = publicKey.export({format: 'jwk'}) as {x: string}
  const rawPublicKey = Buffer.from(jwk.x, 'base64url')
  const protobuf = Buffer.concat([ed25519PublicKeyProtobufPrefix, rawPublicKey])
  // identity multihash: code 0x00, then the length (36, fits in one varint byte)
  const multihash = Buffer.concat([Buffer.from([0x00, protobuf.length]), protobuf])
  return {peerId: base58btc.baseEncode(multihash), privateKey}
}

// multibase base64 (prefix 'm', standard alphabet, no padding) of the ed25519 signature
// over the sha256 digest of the payload bytes
export const signPayload = (peer: TestPeer, payloadJson: string): string => {
  const digest = crypto.createHash('sha256').update(Buffer.from(payloadJson, 'utf8')).digest()
  const signature = crypto.sign(null, digest, peer.privateKey)
  return 'm' + signature.toString('base64').replace(/=+$/, '')
}

export interface ProviderOverrides {
  // null omits the field entirely, a string replaces the real signature
  signature?: string | null
  schema?: string
  protocol?: string
}

// payload may be an object (serialized here) or a raw json string, for tests that need
// exact bytes (whitespace, key order, duplicate keys)
export const signedProviderJson = (peer: TestPeer, payload: object | string, overrides: ProviderOverrides = {}): string => {
  const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const schema = overrides.schema ?? 'bitswap'
  const protocol = overrides.protocol ?? 'transport-bitswap'
  const signature = overrides.signature === undefined ? signPayload(peer, payloadJson) : overrides.signature
  const signatureJson = signature === null ? '' : `"Signature":${JSON.stringify(signature)},`
  return `{"Schema":${JSON.stringify(schema)},"Protocol":${JSON.stringify(protocol)},${signatureJson}"Payload":${payloadJson}}`
}

export const providersBodyJson = (providerJsons: string[]): string => `{"Providers":[${providerJsons.join(',')}]}`

export const signedBodyJson = (peer: TestPeer, payload: object | string, overrides: ProviderOverrides = {}): string =>
  providersBodyJson([signedProviderJson(peer, payload, overrides)])
