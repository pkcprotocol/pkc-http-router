import express, {type Request, type Response} from 'express'
import prometheus from '../lib/prometheus.js'

const router = express.Router()

router.get('/', async (req: Request, res: Response) => {
  const metricsResponse = await prometheus.promClient.register.metrics()
  res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'})
  res.write(metricsResponse)
})

export default router
