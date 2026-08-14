import {describe, it, expect} from 'vitest'
import {extractRawPayloads} from '../../lib/raw-json.js'

const extract = (raw: string): (string | undefined)[] =>
  extractRawPayloads(Buffer.from(raw, 'utf8')).map((payload) => payload?.toString('utf8'))

describe('lib raw-json', () => {
  it('extracts the payload of a single provider', () => {
    const payload = '{"Keys":["cid"],"ID":"peer","Addrs":[]}'
    expect(extract(`{"Providers":[{"Schema":"bitswap","Signature":"msig","Payload":${payload}}]}`)).toEqual([payload])
  })

  it('extracts the payloads of several providers in order', () => {
    const first = '{"ID":"one","Addrs":[]}'
    const second = '{"ID":"two","Addrs":["/ip4/1.2.3.4/tcp/4001"]}'
    expect(extract(`{"Providers":[{"Payload":${first}},{"Payload":${second}}]}`)).toEqual([first, second])
  })

  it('keeps the payload bytes exactly, whitespace included', () => {
    const payload = '{\n  "ID": "peer",\n  "Addrs": [ ]\n}'
    expect(extract(`{ "Providers" : [ { "Payload" : ${payload} } ] }`)).toEqual([payload])
  })

  it('is not confused by json structure inside strings', () => {
    const payload = '{"ID":"peer","Addrs":["/dns/a\\",{}[]/tcp/4001"],"Note":"}]"}'
    expect(extract(`{"Providers":[{"Payload":${payload}}],"Trailing":"}]"}`)).toEqual([payload])
  })

  it('is not confused by an escaped backslash at the end of a string', () => {
    const payload = '{"ID":"peer\\\\","Addrs":[]}'
    expect(extract(`{"Providers":[{"Payload":${payload}}]}`)).toEqual([payload])
  })

  it('handles multibyte utf-8 in the payload', () => {
    const payload = '{"ID":"peer","Note":"日本語 🚀","Addrs":[]}'
    const [extracted] = extract(`{"Providers":[{"Payload":${payload}}]}`)
    expect(extracted).toBe(payload)
  })

  it('handles other members after the payload', () => {
    const payload = '{"ID":"peer","Addrs":[]}'
    expect(extract(`{"Providers":[{"Payload":${payload},"Signature":"msig","Extra":{"a":[1,2,{"b":null}]}}]}`)).toEqual([payload])
  })

  it('handles members before the Providers array', () => {
    const payload = '{"ID":"peer","Addrs":[]}'
    expect(extract(`{"Other":{"nested":[1,2]},"Providers":[{"Payload":${payload}}]}`)).toEqual([payload])
  })

  // JSON.parse keeps the last of duplicate keys, so the scanner must too, otherwise a
  // record could be verified against one payload and stored from another
  it('returns the last of duplicate Payload keys, like JSON.parse', () => {
    const first = '{"ID":"one","Addrs":[]}'
    const second = '{"ID":"two","Addrs":[]}'
    expect(extract(`{"Providers":[{"Payload":${first},"Payload":${second}}]}`)).toEqual([second])
  })

  it('returns the last of duplicate Providers keys, like JSON.parse', () => {
    const first = '{"ID":"one","Addrs":[]}'
    const second = '{"ID":"two","Addrs":[]}'
    expect(extract(`{"Providers":[{"Payload":${first}}],"Providers":[{"Payload":${second}}]}`)).toEqual([second])
  })

  it('returns undefined for a provider without a payload', () => {
    const payload = '{"ID":"peer","Addrs":[]}'
    expect(extract(`{"Providers":[{"Schema":"bitswap"},{"Payload":${payload}}]}`)).toEqual([undefined, payload])
  })

  it('returns an empty array when there is no Providers array', () => {
    expect(extract('{"Other":[]}')).toEqual([])
    expect(extract('[]')).toEqual([])
    expect(extract('')).toEqual([])
  })

  it('returns an empty array on unterminated json instead of throwing', () => {
    expect(extract('{"Providers":[{"Payload":{"ID":"peer"')).toEqual([])
  })
})
