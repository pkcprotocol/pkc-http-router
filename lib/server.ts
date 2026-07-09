import http, {type Server} from 'node:http'
import type {Express} from 'express'

// cloudflared (and most reverse proxies) pool keep-alive connections to the origin and
// reuse an idle one for up to 90s. node's default keepAliveTimeout is 5s, so the origin
// closes sockets the proxy still considers live; a request written on such a socket gets
// no response and is not retried, surfacing in cloudflared logs as "Unable to reach the
// origin service ... EOF" and to the client as a dropped GET/PUT. the origin must always
// outlive the proxy's idle timeout so the proxy is the side that closes idle connections.
const proxyIdleTimeout = 90_000
export const keepAliveTimeout = proxyIdleTimeout + 30_000

// must be longer than keepAliveTimeout or a request whose first bytes arrive just before
// the keep-alive deadline gets killed while its headers are still being read
export const headersTimeout = keepAliveTimeout + 5_000

export const createServer = (app: Express): Server => {
  const server = http.createServer(app)
  server.keepAliveTimeout = keepAliveTimeout
  server.headersTimeout = headersTimeout
  return server
}

export default createServer
