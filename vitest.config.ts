import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    // tests start the express app and a real http server, so run them serially
    // and in a single fork to avoid sqlite/port contention
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
