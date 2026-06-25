import {inspect} from 'node:util'
inspect.defaultOptions.depth = null

import express, {type Request, type Response, type NextFunction} from 'express'
import path from 'node:path'
import type {IncomingMessage} from 'node:http'
import logger from 'morgan'
import cors from 'cors'
import Debug from 'debug'
import indexRouter from './routes/index.js'
import providersRouter from './routes/providers.js'
import prometheusRouter from './routes/prometheus.js'

const debug = Debug('pkc-http-router:server')
const logKey = process.argv.includes('--log-key') && process.argv[process.argv.indexOf('--log-key') + 1]

const app = express()

// remove x-powered-by: express
app.use((req: Request, res: Response, next: NextFunction) => {
  res.removeHeader('X-Powered-By')
  next()
})

// trust x-forwarded-for, the app will almost always use a proxy
app.set('trust proxy', true)

app.use(cors())
if (debug.enabled) {
  // app.use(logger('dev'))
  app.use(logger(':remote-addr :remote-user :user-agent :method :url :status :response-time ms - :res[content-length]'))
}
app.use(express.json({
  limit: '1mb',
  // TODO: kubo doesn't always include content-type header, remove after delegated routing spec
  type: (req: IncomingMessage) => req.method === 'POST' || req.method === 'PUT'
}))
// TODO: figure out why did I comment this out?
// app.use(express.urlencoded({ extended: false }))
// app.use(express.static(path.join(__dirname, 'public')))

// metrics
app.use('/metrics/prometheus', prometheusRouter)
// needed for when used in the plebbit provider because it only proxies /routing/v1/providers/
app.use('/routing/v1/providers/metrics/prometheus', prometheusRouter)

// routes
app.use('/', indexRouter)
app.use('/routing/v1/providers/', providersRouter)

// logs
if (logKey) {
  app.use('/log', express.static(path.join(process.cwd(), 'log')))
}

export default app
