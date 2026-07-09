import {describe, it, expect} from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type {AddressInfo} from 'node:net'
import app from '../../app.js'
import {createServer} from '../../lib/server.js'

// reproduces the cloudflared "Unable to reach the origin service ... EOF" errors seen in
// production: the tunnel pools keep-alive connections to the origin and reuses an idle one
// for up to 90s, but node's default keepAliveTimeout is 5s, so the origin closes sockets
// the proxy still considers live. a request written on such a socket gets no response
// (EOF) and cloudflared does not retry it, so the client's GET/PUT is silently dropped.

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

const close = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()))

const rawRequest = 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n'

describe('http server keep-alive vs reverse proxy connection pool', () => {
  it('ROOT CAUSE: default keepAliveTimeout (5s) closes idle sockets a 90s proxy pool still considers live, so a reused socket gets EOF instead of a response', async () => {
    // server created the way the old bin/www.ts did, all node defaults
    const server = http.createServer(app)
    expect(server.keepAliveTimeout).toBe(5000) // far below the proxy's 90s idle reuse window
    const port = await listen(server)

    const socket = net.connect(port, '127.0.0.1')
    socket.on('error', () => {}) // writing on a dead socket may RST; either way no response arrives
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk
    })

    // first request on the fresh keep-alive connection works
    socket.write(rawRequest)
    await new Promise((resolve) => socket.once('data', resolve))
    expect(data).toContain('HTTP/1.1 200')

    // the origin closes the idle socket at ~5s, long before the proxy would stop reusing it
    const closedByServer = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 7000)
      socket.once('end', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    expect(closedByServer).toBe(true)

    // anything written on the socket now gets no response: the dropped request / EOF
    data = ''
    socket.write(rawRequest)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(data).toBe('')

    socket.destroy()
    await close(server)
  }, 15000)

  it('FIX: createServer outlives the proxy idle window so the proxy is the side that closes idle connections', async () => {
    const server = createServer(app)
    // must outlive cloudflared's 90s idle keep-alive pool, with headersTimeout above it so a
    // request that starts right at the keep-alive deadline still gets its headers read
    expect(server.keepAliveTimeout).toBeGreaterThan(90_000)
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout)
    const port = await listen(server)

    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk
    })

    socket.write(rawRequest)
    await new Promise((resolve) => socket.once('data', resolve))
    expect(data).toContain('HTTP/1.1 200')

    // wait past the old 5s default: the socket must still be open and usable
    let ended = false
    socket.once('end', () => {
      ended = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5500))
    expect(ended).toBe(false)

    data = ''
    socket.write(rawRequest)
    await new Promise((resolve) => socket.once('data', resolve))
    expect(data).toContain('HTTP/1.1 200')

    socket.destroy()
    await close(server)
  }, 15000)
})
