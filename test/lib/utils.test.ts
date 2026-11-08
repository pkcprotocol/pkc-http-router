import {describe, it, expect} from 'vitest'
import {normalizeCid, ipIsUnroutable, ipIsEqual, cleanAddrs, getAddrFilterOptions} from '../../lib/utils.js'

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
  describe('ipIsUnroutable', () => {
    it('rfc1918 / loopback / link-local / unique-local are private', () => {
      expect(ipIsUnroutable('10.0.0.1')).toBe(true)
      expect(ipIsUnroutable('192.168.1.1')).toBe(true)
      expect(ipIsUnroutable('172.16.5.4')).toBe(true)
      expect(ipIsUnroutable('127.0.0.1')).toBe(true)
      expect(ipIsUnroutable('169.254.1.1')).toBe(true)
      expect(ipIsUnroutable('::1')).toBe(true)
      expect(ipIsUnroutable('fc00::1')).toBe(true)
      expect(ipIsUnroutable('fe80::1')).toBe(true)
      // site-local, qemu user networking gives it to guests
      expect(ipIsUnroutable('fec0::4ba:550:1228:cca')).toBe(true)
      // carrier-grade nat, also tailscale
      expect(ipIsUnroutable('100.101.102.103')).toBe(true)
      expect(ipIsUnroutable('224.0.0.1')).toBe(true)
      expect(ipIsUnroutable('255.255.255.255')).toBe(true)
      expect(ipIsUnroutable('192.0.2.1')).toBe(true)
      expect(ipIsUnroutable('2001:db8::1')).toBe(true)
      expect(ipIsUnroutable('ff02::1')).toBe(true)
      expect(ipIsUnroutable('::ffff:10.0.0.1')).toBe(true)
    })
    it('public ips are not private', () => {
      expect(ipIsUnroutable('8.8.8.8')).toBe(false)
      expect(ipIsUnroutable('1.1.1.1')).toBe(false)
      expect(ipIsUnroutable('123.123.123.123')).toBe(false)
      expect(ipIsUnroutable('2606:4700:4700::1111')).toBe(false)
      // just outside carrier-grade nat
      expect(ipIsUnroutable('100.128.0.1')).toBe(false)
      // nat64 and 6to4 are reachable
      expect(ipIsUnroutable('64:ff9b::808:808')).toBe(false)
      expect(ipIsUnroutable('2002:808:808::1')).toBe(false)
    })
    it('invalid ip is not private', () => {
      expect(ipIsUnroutable('not-an-ip')).toBe(false)
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

  describe('getAddrFilterOptions', () => {
    const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
      const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
      const set = (values: Record<string, string | undefined>) => {
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      set(env)
      try {
        fn()
      } finally {
        set(previous)
      }
    }
    it('defaults to dropping unroutable addrs without the strict ip match', () => {
      withEnv({DROP_UNROUTABLE_ADDRS: undefined, STRICT_IP_MATCH: ''}, () => {
        expect(getAddrFilterOptions()).toEqual({dropUnroutableAddrs: true, strictIpMatch: false})
      })
    })
    it('parses boolean values', () => {
      withEnv({DROP_UNROUTABLE_ADDRS: 'false', STRICT_IP_MATCH: '1'}, () => {
        expect(getAddrFilterOptions()).toEqual({dropUnroutableAddrs: false, strictIpMatch: true})
      })
      withEnv({DROP_UNROUTABLE_ADDRS: 'OFF', STRICT_IP_MATCH: 'True'}, () => {
        expect(getAddrFilterOptions()).toEqual({dropUnroutableAddrs: false, strictIpMatch: true})
      })
    })
    it('throws on a value that is not a boolean', () => {
      withEnv({DROP_UNROUTABLE_ADDRS: 'maybe'}, () => {
        expect(() => getAddrFilterOptions()).toThrow(/DROP_UNROUTABLE_ADDRS/)
      })
    })
  })

  describe('cleanAddrs', () => {
    const reqIp = '123.123.123.123'
    it('keeps addrs matching the request ip', () => {
      const cleaned = cleanAddrs([`/ip4/${reqIp}/tcp/4001`], reqIp)
      expect(cleaned).toEqual([`/ip4/${reqIp}/tcp/4001`])
    })
    const addrs = [
      `/ip4/${reqIp}/tcp/4001`,
      `/ip4/192.168.0.1/tcp/4001`,
      `/ip4/8.8.8.8/tcp/4001`,
      '/dns4/example.com/tcp/443/tls/ws',
    ]
    it('by default drops unroutable ips but keeps mismatched public ips and dns addrs', () => {
      expect(cleanAddrs(addrs, reqIp)).toEqual([`/ip4/${reqIp}/tcp/4001`, `/ip4/8.8.8.8/tcp/4001`, '/dns4/example.com/tcp/443/tls/ws'])
    })
    it('with strictIpMatch drops private and mismatched public ips', () => {
      const cleaned = cleanAddrs(addrs, reqIp, {dropUnroutableAddrs: true, strictIpMatch: true})
      expect(cleaned).toEqual([`/ip4/${reqIp}/tcp/4001`, '/dns4/example.com/tcp/443/tls/ws'])
    })
    it('with dropUnroutableAddrs off keeps unroutable ips', () => {
      expect(cleanAddrs(addrs, reqIp, {dropUnroutableAddrs: false, strictIpMatch: false})).toEqual(addrs)
      // strict still drops the private ip because it isn't the request ip, but keeps a
      // private request ip, e.g. testing on a lan
      expect(cleanAddrs(['/ip4/192.168.0.1/tcp/4001'], '192.168.0.1', {dropUnroutableAddrs: false, strictIpMatch: true})).toEqual(['/ip4/192.168.0.1/tcp/4001'])
    })
    it('only validates multiaddrs with strictIpMatch', () => {
      expect(cleanAddrs(['/ip4/8.8.8.8/nope'], reqIp)).toEqual(['/ip4/8.8.8.8/nope'])
      expect(() => cleanAddrs(['/ip4/8.8.8.8/nope'], reqIp, {dropUnroutableAddrs: true, strictIpMatch: true})).toThrow()
    })
    it('rewrites kubo 0.0.0.0 to the request ip', () => {
      const cleaned = cleanAddrs([`/ip4/0.0.0.0/tcp/4001`], reqIp)
      expect(cleaned).toEqual([`/ip4/${reqIp}/tcp/4001`])
    })

    it('rewrites kubo unspecified :: to the request ip', () => {
      const reqIp6 = '2606:4700:4700::1111'
      const cleaned = cleanAddrs(['/ip6/::/tcp/4001'], reqIp6)
      expect(cleaned).toEqual([`/ip6/${reqIp6}/tcp/4001`])
    })

    // the old code replaced the first '::' anywhere in the addr, corrupting legit compressed
    // ipv6 addrs (e.g. /ip6/2606:4700:4700::1111 -> /ip6/2606:4700:47002606:...) before they
    // were stored, so ipv6 announcers ended up with garbage addresses in the database
    it('does not corrupt compressed ipv6 addrs containing ::', () => {
      const reqIp6 = '2606:4700:4700::1111'
      const cleaned = cleanAddrs([`/ip6/${reqIp6}/tcp/4001`], reqIp6)
      expect(cleaned).toEqual([`/ip6/${reqIp6}/tcp/4001`])
    })

    // ROOT CAUSE: the unspecified-address handling matched only the literal strings
    // '/ip4/0.0.0.0' and '/ip6/::', so alternate spellings of the ipv6 unspecified address
    // (/ip6/0:0:0:0:0:0:0:0, /ip6/0::) skipped both the rewrite and the cross-family filter.
    // plain addrs still got dropped later by the ip-equality check, but p2p-circuit addrs are
    // exempt from that check, so circuit addrs with an unspecified (or private) relay ip were
    // stored verbatim in the database
    // FIX: parse the ip component and treat every unspecified-range spelling as the kubo
    // 0.0.0.0 problem, and drop p2p-circuit addrs whose relay ip is private or unspecified
    describe('unspecified and private ips can not bypass validation', () => {
      const reqIp6 = '2606:4700:4700::1111'
      const peerId = 'QmUMqvMcHSFxxDn6sXVhfU641HQtp6WRv84Zez5TDPeGko'

      it('rewrites alternate spellings of the ipv6 unspecified address to the request ip', () => {
        expect(cleanAddrs(['/ip6/0:0:0:0:0:0:0:0/tcp/4001'], reqIp6)).toEqual([`/ip6/${reqIp6}/tcp/4001`])
        expect(cleanAddrs(['/ip6/0::/tcp/4001'], reqIp6)).toEqual([`/ip6/${reqIp6}/tcp/4001`])
        expect(cleanAddrs(['/ip6/::0/tcp/4001'], reqIp6)).toEqual([`/ip6/${reqIp6}/tcp/4001`])
      })

      it('drops unspecified addrs of the other family than the request ip', () => {
        expect(cleanAddrs(['/ip6/0::/tcp/4001'], reqIp)).toEqual([])
        expect(cleanAddrs(['/ip4/0.0.0.0/tcp/4001'], reqIp6)).toEqual([])
      })

      it('drops p2p-circuit addrs with an unspecified relay ip', () => {
        expect(cleanAddrs([`/ip6/0:0:0:0:0:0:0:0/tcp/4001/p2p/${peerId}/p2p-circuit`], reqIp)).toEqual([])
        expect(cleanAddrs([`/ip6/0::/tcp/4001/p2p/${peerId}/p2p-circuit`], reqIp)).toEqual([])
      })

      it('drops p2p-circuit addrs with a private relay ip', () => {
        expect(cleanAddrs([`/ip4/192.168.0.1/tcp/4001/p2p/${peerId}/p2p-circuit`], reqIp)).toEqual([])
        expect(cleanAddrs([`/ip6/::1/tcp/4001/p2p/${peerId}/p2p-circuit`], reqIp6)).toEqual([])
      })

      it('keeps p2p-circuit addrs with a public relay ip different from the request ip', () => {
        const addr = `/ip4/8.8.8.8/tcp/4001/p2p/${peerId}/p2p-circuit`
        expect(cleanAddrs([addr], reqIp)).toEqual([addr])
      })
    })
  })
})
