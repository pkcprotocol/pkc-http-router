import {describe, it, expect} from 'vitest'
import {normalizeCid, ipIsPrivate, ipIsEqual, cleanAddrs} from '../../lib/utils.js'

describe('utils', () => {
  describe('normalizeCid', () => {
    const cidV0DagPbCodecBase58 = 'QmUMqvMcHSFxxDn6sXVhfU641HQtp6WRv84Zez5TDPeGko'
    const cidV1DagPbCodecBase32 = 'bafybeiczorqqam64xocjjjq2vg7eixz6deyex5xbzehuurj45626rtljga'
    const cidV1RawCodecBase32 = 'bafkreiczorqqam64xocjjjq2vg7eixz6deyex5xbzehuurj45626rtljga'
    const normalized = cidV1DagPbCodecBase32

    it('cid v0 dag-pb codec base58 (Qm...)', () => {
      expect(normalizeCid(cidV0DagPbCodecBase58)).toBe(normalized)
    })

    it('cid v1 dag-pb base32 (bafybei...)', () => {
      expect(normalizeCid(cidV1DagPbCodecBase32)).toBe(normalized)
    })

    it('cid v1 raw codec base32 (bafkrei...)', () => {
      expect(normalizeCid(cidV1RawCodecBase32)).toBe(normalized)
    })
  })

  // covers the replacement of the (vulnerable, unmaintained) `ip` package with ipaddr.js
  describe('ipIsPrivate', () => {
    it('rfc1918 / loopback / link-local / unique-local are private', () => {
      expect(ipIsPrivate('10.0.0.1')).toBe(true)
      expect(ipIsPrivate('192.168.1.1')).toBe(true)
      expect(ipIsPrivate('172.16.5.4')).toBe(true)
      expect(ipIsPrivate('127.0.0.1')).toBe(true)
      expect(ipIsPrivate('169.254.1.1')).toBe(true)
      expect(ipIsPrivate('::1')).toBe(true)
      expect(ipIsPrivate('fc00::1')).toBe(true)
      expect(ipIsPrivate('fe80::1')).toBe(true)
    })
    it('public ips are not private', () => {
      expect(ipIsPrivate('8.8.8.8')).toBe(false)
      expect(ipIsPrivate('1.1.1.1')).toBe(false)
      expect(ipIsPrivate('123.123.123.123')).toBe(false)
      expect(ipIsPrivate('2606:4700:4700::1111')).toBe(false)
    })
    it('invalid ip is not private', () => {
      expect(ipIsPrivate('not-an-ip')).toBe(false)
    })
  })

  describe('ipIsEqual', () => {
    it('compares equal ips', () => {
      expect(ipIsEqual('1.2.3.4', '1.2.3.4')).toBe(true)
      expect(ipIsEqual('1.2.3.4', '1.2.3.5')).toBe(false)
      expect(ipIsEqual('::ffff:1.2.3.4', '1.2.3.4')).toBe(true)
      expect(ipIsEqual('2606:4700::1', '2606:4700::1')).toBe(true)
      expect(ipIsEqual('2606:4700::1', '2606:4700::2')).toBe(false)
    })
    it('invalid ips are not equal', () => {
      expect(ipIsEqual('nope', '1.2.3.4')).toBe(false)
    })
  })

  describe('cleanAddrs', () => {
    const reqIp = '123.123.123.123'
    it('keeps addrs matching the request ip', () => {
      const cleaned = cleanAddrs([`/ip4/${reqIp}/tcp/4001`], reqIp)
      expect(cleaned).toEqual([`/ip4/${reqIp}/tcp/4001`])
    })
    it('drops private and mismatched public ips', () => {
      const cleaned = cleanAddrs([
        `/ip4/${reqIp}/tcp/4001`,
        `/ip4/192.168.0.1/tcp/4001`,
        `/ip4/8.8.8.8/tcp/4001`,
      ], reqIp)
      expect(cleaned).toEqual([`/ip4/${reqIp}/tcp/4001`])
    })
    it('rewrites kubo 0.0.0.0 to the request ip', () => {
      const cleaned = cleanAddrs([`/ip4/0.0.0.0/tcp/4001`], reqIp)
      expect(cleaned).toEqual([`/ip4/${reqIp}/tcp/4001`])
    })
  })
})
