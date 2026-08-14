import type {Request} from 'express'

// express.json() only keeps the parsed body, but an ipip-0526 signature covers the raw
// Payload bytes exactly as sent, so app.ts stashes the raw body here for the verifier
export interface RawBodyRequest extends Request {
  rawBody?: Buffer
}

// the provider object as announced by a peer in a PUT /routing/v1/providers/ request
export interface ProviderPayload {
  Keys?: string[]
  Timestamp?: number
  AdvisoryTTL?: number
  ID: string
  Addrs: string[]
}

export interface Provider {
  Schema: string
  Protocol: string
  Signature?: string
  Payload: ProviderPayload
}

// the provider object as returned by GET /routing/v1/providers/:cid
export interface PeerProvider {
  Schema: 'peer'
  Addrs: string[]
  ID: string
  Protocols: string[]
}

// a stored provider entry, with the lastModified timestamp used for expiry
export interface StoredProvider {
  provider: PeerProvider
  lastModified: number
}

// the value stored in the database for a single cid
export interface CidProviders {
  providers: Record<string, StoredProvider>
  lastModified: number
}

export interface GetProvidersResult {
  providers: PeerProvider[]
  lastModified?: number
}
