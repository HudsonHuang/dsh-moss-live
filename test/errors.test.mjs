/**
 * Regression tests for the error messages users see when the call cannot start.
 *
 * The audit that added these tested by hand that a 403 from MOSS reached the
 * panel as an auth message, that an unreachable host reached it as a network
 * message, and that EADDRINUSE named the port and the fix. These assertions
 * keep those distinctions from collapsing back into one generic failure.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeStartError, missingRuntimeDependency } from '../index.js'
import { describeUpstreamFailure } from '../vendor/runtime/server.mjs'

const SETTINGS = { listen: '127.0.0.1:17861', mossUrl: 'wss://api.mosi.cn/v1/realtime' }

test('start errors name the configuration to fix', () => {
  assert.match(describeStartError(new Error('API_KEY_REQUIRED'), SETTINGS), /apiKey/)
  assert.match(describeStartError(new Error('API_KEY_REQUIRED'), SETTINGS), /MOSS_API_KEY/)

  const url = describeStartError(new Error('PUBLIC_WSS_URL_REQUIRED'), { ...SETTINGS, mossUrl: 'http://example.test' })
  assert.match(url, /wss:\/\//)
  assert.match(url, /http:\/\/example\.test/)

  const listen = describeStartError(new Error('INVALID_LOCAL_CONFIGURATION'), SETTINGS)
  assert.match(listen, /127\.0\.0\.1/)
})

test('EADDRINUSE names the port, the alternative and how to find the owner', () => {
  const message = describeStartError(Object.assign(new Error('listen EADDRINUSE 127.0.0.1:17861'), { code: 'EADDRINUSE' }), SETTINGS)
  assert.match(message, /17861/)
  assert.match(message, /17862/)
  assert.match(message, /lsof|netstat/)
})

test('a missing runtime dependency points at npm ci instead of a raw import error', () => {
  const message = describeStartError(Object.assign(new Error("Cannot find package 'ws' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' }), SETTINGS)
  assert.match(message, /npm ci/)
  assert.match(message, /npm run doctor/)
})

test('upstream auth failures are distinguishable from network failures', () => {
  assert.equal(describeUpstreamFailure({ statusCode: 403 }).code, 'MOSS_AUTH_FAILED')
  assert.match(describeUpstreamFailure({ statusCode: 403 }).message, /MOSS_API_KEY/)

  assert.equal(describeUpstreamFailure({ errorCode: 'ECONNREFUSED' }).code, 'MOSS_UNREACHABLE')
  assert.match(describeUpstreamFailure({ errorCode: 'ECONNREFUSED' }).message, /网络|mossUrl/)

  assert.equal(describeUpstreamFailure({ closeCode: 1008 }).code, 'MOSS_AUTH_FAILED')
  assert.equal(describeUpstreamFailure({ closeCode: 1006 }).code, 'MOSS_UNREACHABLE')
})

test('the installed checkout can resolve the relay dependencies', () => {
  assert.equal(missingRuntimeDependency(), '')
})
