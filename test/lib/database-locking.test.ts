import {describe, it, expect} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {Worker} from 'node:worker_threads'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// reproduces issue #2: under a concurrently-held write lock, the SQLite defaults
// (journal_mode=delete, busy_timeout=0) throw "database is locked" instead of waiting,
// which silently dropped provider writes in production. these tests exercise node:sqlite
// directly on a temp file because the bug only appears across connections to a real file,
// never with the :memory: db the rest of the suite uses.

const tmpDbFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkc-lock-'))
  return path.join(dir, 'database.sqlite')
}

describe('sqlite write-lock contention (issue #2)', () => {
  it('ROOT CAUSE: default config throws "database is locked" while another connection holds the write lock', () => {
    const file = tmpDbFile()
    const writer = new DatabaseSync(file)
    writer.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT')

    // second connection with the SQLite defaults the old code used (no pragmas)
    const other = new DatabaseSync(file)

    // hold the write lock open, exactly like the hourly sweep / an in-flight write does
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare('INSERT INTO t VALUES (?, ?)').run('held', '1')

    // with busy_timeout=0 the contending write is rejected immediately instead of waiting -> dropped write
    expect(() => other.prepare('INSERT INTO t VALUES (?, ?)').run('dropped', '2')).toThrow(/database is locked/)

    writer.exec('COMMIT')
    writer.close()
    other.close()
  })

  it('FIX: busy_timeout makes the contending writer wait for the lock instead of throwing', async () => {
    const file = tmpDbFile()
    const setup = new DatabaseSync(file)
    setup.exec('PRAGMA journal_mode = WAL')
    setup.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT')
    setup.close()

    // a worker thread grabs the write lock and holds it ~200ms, then commits. running it in a
    // separate thread is what makes the contention real: the main thread's blocking busy_timeout
    // wait can actually be released while it waits.
    const workerCode = `
      const {parentPort, workerData} = require('node:worker_threads')
      const {DatabaseSync} = require('node:sqlite')
      const db = new DatabaseSync(workerData.file)
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO t VALUES (?, ?)').run('worker', '1')
      parentPort.postMessage('locked')
      const until = Date.now() + 200
      while (Date.now() < until) {} // hold the lock
      db.exec('COMMIT')
      db.close()
      parentPort.postMessage('committed')
    `
    const worker = new Worker(workerCode, {eval: true, workerData: {file}})
    await new Promise<void>((resolve) => worker.once('message', (m) => m === 'locked' && resolve()))

    // a connection without busy_timeout (the old behavior) is rejected right now, lock still held
    const oldConn = new DatabaseSync(file)
    expect(() => oldConn.prepare('INSERT INTO t VALUES (?, ?)').run('old', '2')).toThrow(/database is locked/)
    oldConn.close()

    // a connection configured the way the fixed ProvidersStore now is: it blocks until the worker
    // commits (~200ms) and then succeeds, instead of throwing and dropping the write
    const fixedConn = new DatabaseSync(file)
    fixedConn.exec('PRAGMA busy_timeout = 5000')
    expect(() => fixedConn.prepare('INSERT INTO t VALUES (?, ?)').run('fixed', '3')).not.toThrow()

    const count = (fixedConn.prepare('SELECT COUNT(*) AS n FROM t').get() as {n: number}).n
    expect(count).toBe(2) // worker's row + the fixed connection's row; the old connection's was dropped
    fixedConn.close()

    await worker.terminate()
  })

  it('FIX: WAL lets a reader (GET lookup) proceed while a write lock is held', () => {
    const file = tmpDbFile()
    const writer = new DatabaseSync(file)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT')
    writer.prepare('INSERT INTO t VALUES (?, ?)').run('seed', '1')

    const reader = new DatabaseSync(file)
    reader.exec('PRAGMA busy_timeout = 5000')

    // writer holds an open write transaction (like a long sweep)
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare('INSERT INTO t VALUES (?, ?)').run('inflight', '2')

    // in WAL the reader still sees the last committed snapshot instead of being blocked/erroring
    const row = reader.prepare('SELECT v FROM t WHERE k = ?').get('seed') as {v: string}
    expect(row.v).toBe('1')

    writer.exec('COMMIT')
    writer.close()
    reader.close()
  })
})
