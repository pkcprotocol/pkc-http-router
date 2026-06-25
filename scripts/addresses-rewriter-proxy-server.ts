import http, {type IncomingMessage, type ServerResponse} from 'node:http'
import https from 'node:https'
import {inspect} from 'node:util'
inspect.defaultOptions.depth = null

// debug
const debug = console.log

interface PlebbitOptions {
  ipfsHttpClientsOptions?: (string | {url?: string})[]
}

interface AddressesRewriterProxyServerOptions {
  plebbitOptions: PlebbitOptions
  port: number
  hostname?: string
  proxyTargetUrl: string
}

class AddressesRewriterProxyServer {
  addresses: Record<string, string[]>
  plebbitOptions: PlebbitOptions
  port: number
  hostname: string
  proxyTarget: URL
  server: http.Server

  constructor({plebbitOptions, port, hostname, proxyTargetUrl}: AddressesRewriterProxyServerOptions) {
    this.addresses = {}
    this.plebbitOptions = plebbitOptions
    this.port = port
    this.hostname = hostname || '127.0.0.1'
    this.proxyTarget = new URL(proxyTargetUrl)
    this.server = http.createServer((req, res) => this._proxyRequestRewrite(req, res))
  }

  listen(callback?: () => void): void {
    this._startUpdateAddressesLoop()
    this.server.listen(this.port, this.hostname, callback)
  }

  _proxyRequestRewrite(req: IncomingMessage, res: ServerResponse): void {
    // get post body
    let reqBody = ''
    req.on('data', chunk => {reqBody += chunk.toString()})

    // wait for full post body
    req.on('end', () => {

      // rewrite body with up to date addresses
      let rewrittenBody = reqBody
      let rewrittenBodyJson: {Providers?: {Payload: {ID: string; Addrs: string[]}}[]} | undefined
      if (rewrittenBody) {
        try {
          rewrittenBodyJson = JSON.parse(rewrittenBody)
          for (const provider of rewrittenBodyJson?.Providers || []) {
            const peerId = provider.Payload.ID
            if (this.addresses[peerId]) {
              provider.Payload.Addrs = this.addresses[peerId]
            }
          }
          rewrittenBody = JSON.stringify(rewrittenBodyJson)
        }
        catch (e) {
          debug('proxy body rewrite error:', (e as Error).message)
        }
      }

      // proxy the request
      const {request: httpRequest} = this.proxyTarget.protocol === 'https:' ? https : http
      const requestOptions: http.RequestOptions = {
        hostname: this.proxyTarget.hostname,
        port: this.proxyTarget.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          'Content-Length': Buffer.byteLength(rewrittenBody),
          'content-length': Buffer.byteLength(rewrittenBody),
          host: this.proxyTarget.host
        }
      }
      const proxyReq = httpRequest(requestOptions, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
        proxyRes.pipe(res, {end: true})
      })
      proxyReq.on('error', (e) => {
        debug('proxy error:', e.message)
        res.writeHead(500)
        res.end('Internal Server Error')
      })
      debug({method: req.method, url: req.url, headers: req.headers, body: rewrittenBodyJson})
      proxyReq.write(rewrittenBody)
      proxyReq.end()
    })
  }

  // get up to date listen addresses from kubo every x minutes
  _startUpdateAddressesLoop(): void {
    const tryUpdateAddresses = async () => {
      if (!this.plebbitOptions.ipfsHttpClientsOptions?.length) {
        throw Error('no plebbitOptions.ipfsHttpClientsOptions')
      }
      for (const ipfsHttpClientOptions of this.plebbitOptions.ipfsHttpClientsOptions) {
        const kuboApiUrl = typeof ipfsHttpClientOptions === 'string' ? ipfsHttpClientOptions : ipfsHttpClientOptions.url
        try {
          const idRes = await fetch(`${kuboApiUrl}/id`, {method: 'POST'}).then(res => res.json()) as {ID: string; Addresses: string[]}
          const peerId = idRes.ID
          const swarmRes = await fetch(`${kuboApiUrl}/swarm/addrs/listen`, {method: 'POST'}).then(res => res.json()) as {Strings: string[]}
          // merge id and swarm addresses to make sure no addresses are missing
          this.addresses[peerId] = [...new Set([...swarmRes.Strings, ...idRes.Addresses])]
        }
        catch (e) {
          debug('tryUpdateAddresses error:', (e as Error).message, {kuboApiUrl})
        }
      }
    }
    tryUpdateAddresses()
    setInterval(tryUpdateAddresses, 1000 * 60)
  }
}

// example
const addressesRewriterProxyServer = new AddressesRewriterProxyServer({
  plebbitOptions: {ipfsHttpClientsOptions: ['http://127.0.0.1:5001/api/v0']},
  port: 8888,
  proxyTargetUrl: 'https://peers.pleb.bot',
  // proxyTargetUrl: 'http://127.0.0.1:8889',
})
addressesRewriterProxyServer.listen(() => {
  console.log(`addresses rewriter proxy listening on http://${addressesRewriterProxyServer.hostname}:${addressesRewriterProxyServer.port}`)
})

/* example of how to use in plebbit-js

const httpRouterProxyUrls = []
if (isNodeJs && plebbitOptions.ipfsHttpClientsOptions?.length && plebbitOptions.httpRoutersOptions?.length) {
  let addressesRewriterStartPort = 19575 // use port 19575 as first port, looks like IPRTR (IPFS ROUTER)
  for (const httpRoutersOptions of plebbitOptions.httpRoutersOptions) {
    // launch the proxy server
    const port = addressesRewriterStartPort++
    const hostname = '127.0.0.1'
    const addressesRewriterProxyServer = new AddressesRewriterProxyServer({
      plebbitOptions: plebbitOptions,
      port,
      hostname,
      proxyTargetUrl: httpRoutersOptions.url || httpRoutersOptions,
    })
    addressesRewriterProxyServer.listen()

    // save the proxy urls to use them later
    httpRouterProxyUrls.push(`http://${hostname}:${port}`)
  }

  // set kubo to the new routers with the proxy urls
  setKuboHttpRouterUrls(httpRouterProxyUrls)
}
*/
