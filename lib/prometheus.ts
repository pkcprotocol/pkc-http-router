import promClient from 'prom-client'

const prefix = 'ipfs_tracker_'

promClient.collectDefaultMetrics({prefix})

const up = new promClient.Gauge({
  name: `${prefix}up`,
  help: '1 = up, 0 = not up',
  registers: [promClient.register]
})
up.set(1)

const counterLabelNames: string[] = []
const counters = {
  getProvidersRequestCount: new promClient.Counter({
    name: `${prefix}get_providers_request_count`,
    help: `count of ipfs tracker get providers request labeled with: ${counterLabelNames.join(', ')}`,
    labelNames: counterLabelNames, registers: [promClient.register]
  }),
  getProvidersRequestSuccessCount: new promClient.Counter({
    name: `${prefix}get_providers_request_success_count`,
    help: `count of ipfs tracker get providers request success labeled with: ${counterLabelNames.join(', ')}`,
    labelNames: counterLabelNames, registers: [promClient.register]
  }),
  getProvidersProviderCount: new promClient.Counter({
    name: `${prefix}get_providers_provider_count`,
    help: `count of ipfs tracker get providers provider amount labeled with: ${counterLabelNames.join(', ')}`,
    labelNames: counterLabelNames, registers: [promClient.register]
  }),
  postProvidersRequestCount: new promClient.Counter({
    name: `${prefix}post_providers_request_count`,
    help: `count of ipfs tracker post providers request labeled with: ${counterLabelNames.join(', ')}`,
    labelNames: counterLabelNames, registers: [promClient.register]
  }),
  postProvidersRequestSuccessCount: new promClient.Counter({
    name: `${prefix}post_providers_request_success_count`,
    help: `count of ipfs tracker post providers request success labeled with: ${counterLabelNames.join(', ')}`,
    labelNames: counterLabelNames, registers: [promClient.register]
  }),
  postProvidersProviderCount: new promClient.Counter({
    name: `${prefix}post_providers_provider_count`,
    help: `count of ipfs tracker post providers provider amount labeled with: ${counterLabelNames.join(', ')}`,
    labelNames: counterLabelNames, registers: [promClient.register]
  })
}

const labels = {}
const getProviders = (): void => {
  counters.getProvidersRequestCount.inc(labels, 1)
}
const getProvidersSuccess = (): void => {
  counters.getProvidersRequestSuccessCount.inc(labels, 1)
}
const getProvidersProviders = (providers?: {length?: number}): void => {
  if (typeof providers?.length === 'number') {
    counters.getProvidersProviderCount.inc(labels, providers.length)
  }
}
const postProviders = (): void => {
  counters.postProvidersRequestCount.inc(labels, 1)
}
const postProvidersSuccess = (): void => {
  counters.postProvidersRequestSuccessCount.inc(labels, 1)
}
const postProvidersProviders = (providers?: {length?: number}): void => {
  if (typeof providers?.length === 'number') {
    counters.postProvidersProviderCount.inc(labels, providers.length)
  }
}

const prometheus = {promClient, prefix, getProviders, postProviders, getProvidersSuccess, postProvidersSuccess, getProvidersProviders, postProvidersProviders}
export default prometheus
