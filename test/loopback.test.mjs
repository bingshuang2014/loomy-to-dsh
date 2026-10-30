import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hostIsLoopback,
  originIsLoopback,
  hostnameOfHost,
  isFetchBlockedPort,
} from '../loopback.js'

test('hostIsLoopback accepts loopback hosts with and without a port', () => {
  assert.equal(hostIsLoopback('127.0.0.1'), true)
  assert.equal(hostIsLoopback('127.0.0.1:39271'), true)
  assert.equal(hostIsLoopback('localhost:8080'), true)
  assert.equal(hostIsLoopback('[::1]:9000'), true)
  assert.equal(hostIsLoopback('evil.example.com'), false)
  assert.equal(hostIsLoopback(undefined), false)
  assert.equal(hostIsLoopback(''), false)
})

test('hostnameOfHost strips only a trailing numeric port', () => {
  assert.equal(hostnameOfHost('127.0.0.1:39271'), '127.0.0.1')
  assert.equal(hostnameOfHost('localhost:8080'), 'localhost')
  assert.equal(hostnameOfHost('[::1]:9000'), '[::1]')
  // an unbracketed IPv6 literal has multiple colons and must not be truncated
  assert.equal(hostnameOfHost('::1'), '::1')
})

test('originIsLoopback passes when absent and rejects non-loopback', () => {
  assert.equal(originIsLoopback(undefined), true)
  assert.equal(originIsLoopback(''), true)
  assert.equal(originIsLoopback('http://127.0.0.1:52974'), true)
  assert.equal(originIsLoopback('http://localhost:52974'), true)
  assert.equal(originIsLoopback('http://evil.example.com'), false)
  assert.equal(originIsLoopback('not a url'), false)
})

test('isFetchBlockedPort flags the fetch bad-port list', () => {
  assert.equal(isFetchBlockedPort(22), true)
  assert.equal(isFetchBlockedPort(25), true)
  assert.equal(isFetchBlockedPort(6000), true)
  assert.equal(isFetchBlockedPort(39271), false)
  assert.equal(isFetchBlockedPort(0), false)
})
