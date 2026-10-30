import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLoomySession,
  maskSession,
  accountKeyOf,
} from '../session.js'

test('parseLoomySession accepts a well-formed body', () => {
  const session = parseLoomySession({ session: 'f226e186fefe4213bfa4547aa24cd8c2', userid: '260817092126029524', updatedAt: 1792543703462, phone: '18146510461' })
  assert.equal(session.session, 'f226e186fefe4213bfa4547aa24cd8c2')
  assert.equal(session.userid, '260817092126029524')
  assert.equal(session.phone, '18146510461')
  assert.equal(session.updatedAt, 1792543703462)
})

test('parseLoomySession rejects an empty session', () => {
  assert.equal(parseLoomySession({ session: '', userid: 'u' }), undefined)
  assert.equal(parseLoomySession({ session: '   ', userid: 'u' }), undefined)
  assert.equal(parseLoomySession(null), undefined)
})

test('parseLoomySession tolerates a missing userid', () => {
  const session = parseLoomySession({ session: 'abc' })
  assert.equal(session.session, 'abc')
  assert.equal(session.userid, '')
  assert.equal(session.updatedAt, undefined)
})

test('maskSession keeps head and tail, never the middle', () => {
  assert.equal(maskSession('f226e186fefe4213bfa4547aa24cd8c2'), 'f226…8c2')
  assert.equal(maskSession('short'), '***')
  assert.equal(maskSession(''), '')
})

test('accountKeyOf is the userid when present, else undefined', () => {
  assert.equal(accountKeyOf({ userid: 'u1', session: 'x' }), 'u1')
  assert.equal(accountKeyOf({ userid: '', session: 'x' }), undefined)
  assert.equal(accountKeyOf(undefined), undefined)
})
