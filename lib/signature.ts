import crypto from 'node:crypto'
import {bases} from 'multiformats/basics'
import {decode as decodeMultihash} from 'multiformats/hashes/digest'
import {CID} from 'multiformats/cid'
import type {Provider} from './types.js'

// signature verification for PUT /routing/v1/providers/ records, as documented in
// ipip-0526:
// https://github.com/ipfs/specs/blob/4d13666f1d2915e03e6f8f8f86a710779e826e8a/src/ipips/ipip-0526.md
//
// without it anyone can publish a record claiming to be any peer id, and since a peer's
// addrs are stored once and shared by every cid it announces, a single forged record
// keeps that peer unreachable for everyone until it re-announces (and only until the
// attacker announces again). the request-ip check in cleanAddrs does not help: the
// attacker announces its own ip, it just claims someone else's peer id.

// how stale a Payload.Timestamp may be before the record is rejected as a replay. wide,
// because it only has to be shorter than the 24h record ttl to be useful, and clients with
// a badly wrong clock would otherwise be locked out
const maxTimestampAge = 1000 * 60 * 60 * 24
// tolerance for clients whose clock runs ahead
const maxTimestampSkew = 1000 * 60 * 60

// libp2p PublicKey protobuf: `message PublicKey {KeyType Type = 1; bytes Data = 2}`
const keyTypeRsa = 0
const keyTypeEd25519 = 1
const keyTypeSecp256k1 = 2
const keyTypeEcdsa = 3
const keyTypeNames: Record<number, string> = {[keyTypeRsa]: 'rsa', [keyTypeEd25519]: 'ed25519', [keyTypeSecp256k1]: 'secp256k1', [keyTypeEcdsa]: 'ecdsa'}

const identityMultihashCode = 0x00
const libp2pKeyCodec = 0x72

// der prefixes that turn a raw public key into a SPKI document node's crypto can import
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
// secp256k1 with a 33 byte compressed point
const secp256k1SpkiPrefix = Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex')

const multibaseDecoders = new Map<string, {decode: (text: string) => Uint8Array}>(Object.values(bases).map((base) => [base.prefix as string, base]))

// every multibase encoding is accepted, the reference client uses base64 ('m')
const decodeMultibase = (text: string): Uint8Array => {
  const decoder = multibaseDecoders.get(text[0])
  if (!decoder) {
    throw new Error(`unknown multibase prefix '${text[0]}'`)
  }
  return decoder.decode(text)
}

// minimal protobuf reader for the two fields of libp2p's PublicKey message
const decodePublicKeyProtobuf = (bytes: Uint8Array): {type: number; data: Uint8Array} => {
  let index = 0
  let type: number | undefined
  let data: Uint8Array | undefined
  const readVarint = (): number => {
    let value = 0
    let shift = 0
    while (index < bytes.length) {
      const byte = bytes[index++]
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) {
        return value
      }
      shift += 7
    }
    throw new Error('truncated varint')
  }
  while (index < bytes.length) {
    const tag = readVarint()
    const field = tag >> 3
    const wireType = tag & 0x7
    if (field === 1 && wireType === 0) {
      type = readVarint()
    }
    else if (field === 2 && wireType === 2) {
      const length = readVarint()
      data = bytes.subarray(index, index + length)
      index += length
    }
    else if (wireType === 0) {
      readVarint()
    }
    else if (wireType === 2) {
      index += readVarint()
    }
    else {
      throw new Error(`unsupported protobuf wire type ${wireType}`)
    }
  }
  if (type === undefined || data === undefined) {
    throw new Error('public key protobuf missing Type or Data')
  }
  return {type, data}
}

// peer ids are a multihash of the public key protobuf, base58btc encoded, or a cidv1 with
// the libp2p-key codec. only an identity multihash carries the key itself: rsa and ecdsa
// peer ids are a sha256 of it, so their records can never be verified (ipip-0526)
const publicKeyProtobufFromPeerId = (peerId: string): Uint8Array => {
  let multihashBytes: Uint8Array
  if (peerId.startsWith('Qm') || peerId.startsWith('1')) {
    multihashBytes = bases.base58btc.baseDecode(peerId)
  }
  else {
    const cid = CID.parse(peerId)
    if (cid.code !== libp2pKeyCodec) {
      throw new Error(`peer id '${peerId}' is not a libp2p-key cid`)
    }
    multihashBytes = cid.multihash.bytes
  }
  const multihash = decodeMultihash(multihashBytes)
  if (multihash.code !== identityMultihashCode) {
    throw new Error(`peer id '${peerId}' does not embed a public key`)
  }
  return multihash.digest
}

interface PublicKey {
  keyObject: crypto.KeyObject
  // ed25519 signs the digest directly, secp256k1 hashes it again before signing
  type: number
}

export const publicKeyFromPeerId = (peerId: string): PublicKey => {
  const {type, data} = decodePublicKeyProtobuf(publicKeyProtobufFromPeerId(peerId))
  if (type === keyTypeEd25519) {
    if (data.length !== 32) {
      throw new Error(`ed25519 public key of peer id '${peerId}' is ${data.length} bytes, expected 32`)
    }
    const der = Buffer.concat([ed25519SpkiPrefix, data])
    return {keyObject: crypto.createPublicKey({key: der, format: 'der', type: 'spki'}), type}
  }
  if (type === keyTypeSecp256k1) {
    if (data.length !== 33) {
      throw new Error(`secp256k1 public key of peer id '${peerId}' is ${data.length} bytes, expected 33`)
    }
    const der = Buffer.concat([secp256k1SpkiPrefix, data])
    return {keyObject: crypto.createPublicKey({key: der, format: 'der', type: 'spki'}), type}
  }
  throw new Error(`peer id '${peerId}' uses unsupported key type ${keyTypeNames[type] ?? type}`)
}

// the reasons are prometheus label values, keep them low cardinality
export type VerifyFailureReason = 'missing_signature' | 'missing_id' | 'missing_payload_bytes' | 'unsupported_key' | 'invalid_signature' | 'missing_timestamp' | 'stale_timestamp' | 'future_timestamp'

export interface VerifyResult {
  valid: boolean
  reason?: VerifyFailureReason
  error?: string
}

// verifies the signature over the raw payload bytes, ignoring Payload.Timestamp
export const verifySignature = (provider: Provider, rawPayload: Buffer | undefined): VerifyResult => {
  if (typeof provider.Signature !== 'string' || !provider.Signature) {
    return {valid: false, reason: 'missing_signature', error: 'record has no Signature'}
  }
  if (typeof provider.Payload?.ID !== 'string' || !provider.Payload.ID) {
    return {valid: false, reason: 'missing_id', error: 'record has no Payload.ID'}
  }
  if (!rawPayload?.length) {
    // the payload parsed but its bytes couldn't be located in the request body, which
    // means the scanner and JSON.parse disagree about the body; refuse rather than guess
    return {valid: false, reason: 'missing_payload_bytes', error: 'could not read the Payload bytes of the request body'}
  }
  let publicKey: PublicKey
  try {
    publicKey = publicKeyFromPeerId(provider.Payload.ID)
  } catch (e) {
    return {valid: false, reason: 'unsupported_key', error: (e as Error).message}
  }
  let signature: Uint8Array
  try {
    signature = decodeMultibase(provider.Signature)
  } catch (e) {
    return {valid: false, reason: 'invalid_signature', error: `could not decode Signature: ${(e as Error).message}`}
  }
  const digest = crypto.createHash('sha256').update(rawPayload).digest()
  let valid = false
  try {
    // libp2p signs the sha256 digest of the payload: ed25519 signs those 32 bytes
    // directly, secp256k1 goes through ecdsa, which hashes its message first
    valid = publicKey.type === keyTypeEd25519
      ? crypto.verify(null, digest, publicKey.keyObject, signature)
      : crypto.verify('sha256', digest, publicKey.keyObject, signature)
  } catch (e) {
    return {valid: false, reason: 'invalid_signature', error: `could not verify Signature: ${(e as Error).message}`}
  }
  if (!valid) {
    return {valid: false, reason: 'invalid_signature', error: 'signature does not match the Payload'}
  }
  return {valid: true}
}

// a signature stays valid forever, so without a timestamp check an attacker who captured
// a peer's older record can replay it to pin the peer's stale addrs back on
export const verifyTimestamp = (provider: Provider, now: number = Date.now()): VerifyResult => {
  const timestamp = provider.Payload?.Timestamp
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return {valid: false, reason: 'missing_timestamp', error: 'record has no Payload.Timestamp'}
  }
  if (timestamp < now - maxTimestampAge) {
    return {valid: false, reason: 'stale_timestamp', error: `Payload.Timestamp ${timestamp} is older than ${maxTimestampAge}ms`}
  }
  if (timestamp > now + maxTimestampSkew) {
    return {valid: false, reason: 'future_timestamp', error: `Payload.Timestamp ${timestamp} is more than ${maxTimestampSkew}ms in the future`}
  }
  return {valid: true}
}

export const verifyProvider = (provider: Provider, rawPayload: Buffer | undefined, now: number = Date.now()): VerifyResult => {
  const signatureResult = verifySignature(provider, rawPayload)
  if (!signatureResult.valid) {
    return signatureResult
  }
  return verifyTimestamp(provider, now)
}

// verification is on unless explicitly turned off, for deployments where the router only
// accepts records from trusted clients (localhost, private network) or during an incident
export const verificationEnabled = (): boolean => process.env.VERIFY_SIGNATURES !== '0'
