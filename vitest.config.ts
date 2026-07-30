import { defineConfig } from 'vitest/config'
import { GOOD_ENV } from './test/fixtures.js'

export default defineConfig({
  test: {
    // Every suite mutates process.env and re-imports config.ts, which validates at
    // module load. Shared workers would race on that; one fork keeps each file's
    // environment its own.
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // config.ts validates at module load, so any suite that imports the app needs a
    // well-formed environment before the first import. These are inert fake values:
    // the suite signs its own webhook payloads locally and never calls Stripe.
    // config.ts validates at module load, so any suite that imports the app needs a
    // well-formed environment before the first import. These are inert, assembled
    // fixtures — see test/fixtures.ts. The suite signs its own webhook payloads
    // locally and never calls Stripe.
    env: { ...GOOD_ENV },
  },
})
