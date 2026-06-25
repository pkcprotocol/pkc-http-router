import http from 'node:http'
import {inspect} from 'node:util'
inspect.defaultOptions.depth = null

const hostname = '127.0.0.1'
const port = 8889

const server = http.createServer((req, res) => {
  let reqBody = ''
  req.on('data', chunk => {reqBody += chunk})
  req.on('end', () => {
    let body: unknown = reqBody
    try {
      body = JSON.parse(reqBody)
    }
    catch {}
    console.log({method: req.method, url: req.url, headers: req.headers, body})
    res.end()
  })
})

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`)
})
