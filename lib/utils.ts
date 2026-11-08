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

// special-purpose ranges nobody on the public internet can dial: private networks, loopback,
// link-local, carrier-grade nat (which is also where tailscale addrs live), site-local (what
// qemu user networking gives a guest), multicast/broadcast, and documentation, benchmarking or
// identifier-only blocks. names are ipaddr.js range() names. not included: 6to4, teredo, nat64
// and the anycast as112/amt blocks, those are reachable
const unroutableIpv4Ranges = new Set(['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'carrierGradeNat', 'private', 'reserved'])
const unroutableIpv6Ranges = new Set(['unspecified', 'linkLocal', 'multicast', 'loopback', 'uniqueLocal', 'deprecatedSiteLocal', 'discard', 'benchmarking', 'deprecatedOrchid', 'orchid2', 'droneRemoteIdProtocolEntityTags', 'segmentRouting', 'reserved'])

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

export const ipIsUnroutable = (ip: string): boolean => {
  const parsed = parseIp(ip)
  if (!parsed) {
    return false
  }
  const ranges = parsed.kind() === 'ipv4' ? unroutableIpv4Ranges : unroutableIpv6Ranges
  return ranges.has(parsed.range())
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

export interface AddrFilterOptions {
  // drop addrs whose ip (or p2p-circuit relay ip) is in an unroutable range
  dropUnroutableAddrs: boolean
  // drop non-circuit addrs whose ip differs from the request ip, and reject the request
  // when an addr is not a valid multiaddr
  strictIpMatch: boolean
}

const parseBooleanEnv = (name: string, defaultValue: boolean): boolean => {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) {
    return defaultValue
  }
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false
  }
  throw Error(`invalid ${name}='${process.env[name]}', expected true or false`)
}

// read on every call so the settings can't drift from the environment, app.ts also calls it
// once at startup so a typo fails there instead of on every announce
export const getAddrFilterOptions = (): AddrFilterOptions => ({
  dropUnroutableAddrs: parseBooleanEnv('DROP_UNROUTABLE_ADDRS', true),
  strictIpMatch: parseBooleanEnv('STRICT_IP_MATCH', false)
})

export const cleanAddrs = (addrs: string[], reqIp: string, options: AddrFilterOptions = getAddrFilterOptions()): string[] => {
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

  const cleaned: string[] = []
  for (const addr of addrs) {
    if (options.strictIpMatch) {
      // validate multiaddr
      multiaddr(addr)
    }

    const ip = addr.match(/^\/ip(?:4|6)\/([^/]+)/)?.[1]
    if (!ip) {
      // TODO: what to do if addr is dns or other, doesn't contain an ip that we can validate?
      // allow for now
      cleaned.push(addr)
      continue
    }
    // also covers p2p-circuit addrs: a private relay ip is unreachable for everyone
    if (options.dropUnroutableAddrs && ipIsUnroutable(ip)) {
      continue
    }
    // TODO: how to stop spam from p2p circuit addresses?
    if (options.strictIpMatch && !ipIsEqual(ip, reqIp) && !addr.includes('p2p-circuit')) {
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
