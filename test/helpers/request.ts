import type {AddressInfo} from 'node:net'
import type {Server} from 'node:http'
import app from '../../app.js'

let server: Server | undefined
let baseUrl: string | undefined

// start the express app on an ephemeral port (lazily, once per test file)
export const startServer = async (): Promise<string> => {
  if (baseUrl) {
    return baseUrl
  }
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const {port} = server!.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  return baseUrl
}

export const closeServer = async (): Promise<void> => {
  if (!server) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => (err ? reject(err) : resolve()))
  })
  server = undefined
  baseUrl = undefined
}

export interface TestResponse {
  status: number
  headers: Record<string, string>
  text: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

export interface RequestOptions {
  headers?: Record<string, string>
  body?: unknown
}

// tiny fetch-based request helper (replaces supertest and its vulnerable transitive deps)
export const request = async (method: string, pathname: string, opts: RequestOptions = {}): Promise<TestResponse> => {
  const base = await startServer()
  const headers = {...(opts.headers || {})}
  let body: string | undefined
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  }
  const res = await fetch(base + pathname, {method, headers, body})
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    parsed = undefined
  }
  const headersObject: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headersObject[key] = value
  })
  return {status: res.status, headers: headersObject, text, body: parsed}
}
