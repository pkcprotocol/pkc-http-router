import {multiaddr} from '@multiformats/multiaddr'
import ipaddr from 'ipaddr.js'
import assert from 'node:assert'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import type {Request} from 'express'
import {CID} from 'multiformats/cid'

const logKey = process.argv.includes('--log-key') && process.argv[process.argv.indexOf('--log-key') + 1]
const logFolderPath = path.join(process.cwd(), 'log')
const logPath = logKey ? path.join(logFolderPath, logKey) : undefined
if (logKey) {
  fs.mkdirSync(logFolderPath, {recursive: true})
}

export const logPostProviders = (req: Request): void => {
  if (!logKey || !logPath) {
    return
  }
  const timestamp = new Date().toISOString()
  const ip = req.ip
  for (const provider of req.body?.Providers || []) {
    const peerId = provider?.Payload?.ID
    const addressCount = provider?.Payload?.Addrs?.length
    for (const key of provider?.Payload?.Keys || []) {
      const cid = key
      // logging runs before request validation, a bad key must not throw a 500 here
      let cidV1 = 'invalid'
      try {
        cidV1 = normalizeCid(cid)
      } catch {}
      const log = `${timestamp} ${ip} ${peerId} ${addressCount} ${cid} ${cidV1}\n`
      fs.appendFileSync(logPath, log, 'utf8')
    }
  }
}

export const randomizeArray = <T>(array: T[]): T[] => {
  // fisher-yates shuffle
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = array[i]
    array[i] = array[j]
    array[j] = tmp
  }
  return array
}

export const removeDuplicates = <T>(array: T[]): T[] => [...new Set(array)]

// ranges that the legacy `ip` package treated as private (RFC1918, loopback, link-local, unique-local, unspecified)
const privateIpRanges = new Set(['private', 'uniqueLocal', 'loopback', 'linkLocal', 'unspecified'])

const parseIp = (ip: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined => {
  try {
    let parsed = ipaddr.parse(ip)
    // normalize ipv4-mapped ipv6 (::ffff:1.2.3.4) to plain ipv4 so comparisons/ranges match
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address()
    }
    return parsed
  }
  catch {
    return undefined
  }
}

export const ipIsPrivate = (ip: string): boolean => {
  const parsed = parseIp(ip)
  if (!parsed) {
    return false
  }
  return privateIpRanges.has(parsed.range())
}

const ipIsUnspecified = (ip: string): boolean => parseIp(ip)?.range() === 'unspecified'

export const ipIsEqual = (a: string, b: string): boolean => {
  const parsedA = parseIp(a)
  const parsedB = parseIp(b)
  if (!parsedA || !parsedB || parsedA.kind() !== parsedB.kind()) {
    return false
  }
  const bytesA = parsedA.toByteArray()
  const bytesB = parsedB.toByteArray()
  return bytesA.length === bytesB.length && bytesA.every((byte, i) => byte === bytesB[i])
}

export const cleanAddrs = (addrs: string[], reqIp: string): string[] => {
  assert(reqIp && typeof reqIp === 'string', `cleanAddrs reqIp '${reqIp} not a string`)
  // remove nodejs prefix
  if (reqIp.startsWith('::ffff:')) {
    reqIp = reqIp.replace('::ffff:', '')
  }

  // fix the ip 0.0.0.0 kubo problem: kubo announces the unspecified address when it doesn't
  // know its public ip, so substitute the ip the request actually came from. parse the ip
  // component instead of matching the literal strings '/ip4/0.0.0.0' and '/ip6/::' so alternate
  // spellings like /ip6/0:0:0:0:0:0:0:0 can't slip through, and drop unspecified addrs of the
  // other family than the request ip, they can't be substituted
  const reqIpVersion = net.isIP(reqIp)
  addrs = addrs.flatMap(addr => {
    const ipComponent = addr.match(/^\/ip(4|6)\/([^/]+)/)
    if (!ipComponent || !ipIsUnspecified(ipComponent[2])) {
      return [addr]
    }
    if (Number(ipComponent[1]) !== reqIpVersion) {
      return []
    }
    return [`/ip${ipComponent[1]}/${reqIp}${addr.slice(ipComponent[0].length)}`]
  })

  // useful for testing
  if (process.env.NO_IP_VALIDATE) {
    return [...addrs]
  }

  const cleaned: string[] = []
  for (const addr of addrs) {
    // validate multiaddr
    multiaddr(addr)

    const ip = addr.match(/^\/ip(?:4|6)\/([^/]+)/)?.[1]
    if (!ip) {
      // TODO: what to do if addr is dns or other, doesn't contain an ip that we can validate?
      // allow for now
    }
    else if (!ipIsEqual(ip, reqIp)) {
      // TODO: how to stop spam from p2p circuit addresses?
      if (!addr.includes('p2p-circuit')) {
        continue
      }
      // circuit addrs are exempt from the ip-equality check, but a private or unspecified
      // relay ip is unreachable for everyone, don't store it
      if (ipIsPrivate(ip)) {
        continue
      }
    }
    else if (ipIsPrivate(ip)) {
      continue
    }
    cleaned.push(addr)
  }
  return cleaned
}

// normalize to cid v1 dag-pb codec base32
const dagPbCodec = 0x70
const cidV1 = 1
export const normalizeCid = (cidString: string): string => {
  const cid = CID.parse(cidString)
  // cid is correct codec
  if (cid.code === dagPbCodec) {
    return cid.toV1().toString()
  }
  const dagPbCid = CID.create(cidV1, dagPbCodec, cid.multihash)
  return dagPbCid.toString()
}
