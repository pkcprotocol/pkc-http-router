import express, {type Request, type Response} from 'express'
import prometheus from '../lib/prometheus.js'

const router = express.Router()

router.get('/', async (req: Request, res: Response) => {
  const metricsResponse = await prometheus.promClient.register.metrics()
  res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'})
  // res.write() alone never terminates the response, every scrape hangs until client timeout
  res.end(metricsResponse)
})

export default router
