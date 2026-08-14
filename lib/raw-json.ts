// ipip-0526 signatures cover the Payload bytes exactly as they appear in the request
// body, so the parsed object can't be used to verify them: re-serializing it with
// JSON.stringify would only match clients that serialize keys in the same order, with the
// same whitespace and the same number formatting. this scans the raw body for the byte
// range of each Providers[i].Payload value instead.
//
// scanning is done over a latin1 view of the buffer so string indexes are byte indexes:
// every structural character of json is ascii, and every byte of a multi-byte utf-8
// sequence is >= 0x80, so a latin1 view can never mistake payload content for structure,
// and the slices come out of the original buffer byte for byte.

interface Range {
  start: number
  end: number
}

const whitespace = new Set([' ', '\t', '\n', '\r'])
// characters that end an unquoted value (number, true, false, null)
const valueTerminators = new Set([',', ']', '}', ':', ' ', '\t', '\n', '\r'])

const skipWhitespace = (raw: string, index: number): number => {
  while (index < raw.length && whitespace.has(raw[index])) {
    index++
  }
  return index
}

// index of the character after the string starting at raw[index] === '"'
const skipString = (raw: string, index: number): number => {
  index++
  while (index < raw.length) {
    if (raw[index] === '\\') {
      index += 2
      continue
    }
    if (raw[index] === '"') {
      return index + 1
    }
    index++
  }
  throw new Error('unterminated string')
}

// index of the character after the value starting at raw[index]
const skipValue = (raw: string, index: number): number => {
  index = skipWhitespace(raw, index)
  const character = raw[index]
  if (character === undefined) {
    throw new Error('unexpected end of json')
  }
  if (character === '"') {
    return skipString(raw, index)
  }
  if (character === '{' || character === '[') {
    const closing = character === '{' ? '}' : ']'
    index++
    while (true) {
      index = skipWhitespace(raw, index)
      if (index >= raw.length) {
        throw new Error('unterminated object or array')
      }
      if (raw[index] === closing) {
        return index + 1
      }
      // keys, ':' and ',' are all skipped by the same loop, the body has already been
      // parsed by express so it doesn't need to be validated again here
      if (raw[index] === ',' || raw[index] === ':') {
        index++
        continue
      }
      index = skipValue(raw, index)
    }
  }
  const start = index
  while (index < raw.length && !valueTerminators.has(raw[index])) {
    index++
  }
  if (index === start) {
    throw new Error(`unexpected character '${character}'`)
  }
  return index
}

// range of the value of `name` in the object starting at raw[start] === '{', or undefined.
// returns the *last* match, because JSON.parse keeps the last of duplicate keys and this
// must agree with the object the router actually stores, or a record could be verified
// against one payload and stored from another
const objectMember = (raw: string, start: number, name: string): Range | undefined => {
  let index = skipWhitespace(raw, start)
  if (raw[index] !== '{') {
    return undefined
  }
  index++
  let found: Range | undefined
  while (true) {
    index = skipWhitespace(raw, index)
    if (index >= raw.length) {
      throw new Error('unterminated object')
    }
    if (raw[index] === '}') {
      return found
    }
    if (raw[index] === ',') {
      index++
      continue
    }
    if (raw[index] !== '"') {
      throw new Error(`unexpected character '${raw[index]}' in object`)
    }
    const keyEnd = skipString(raw, index)
    const key = raw.slice(index + 1, keyEnd - 1)
    index = skipWhitespace(raw, keyEnd)
    if (raw[index] !== ':') {
      throw new Error('missing ":" after object key')
    }
    const valueStart = skipWhitespace(raw, index + 1)
    const valueEnd = skipValue(raw, valueStart)
    // escapes in the key would need unescaping to compare, but the keys this looks for
    // ('Providers', 'Payload') contain no escapable character, so an escaped key simply
    // doesn't match, exactly like it doesn't match for JSON.parse
    if (key === name) {
      found = {start: valueStart, end: valueEnd}
    }
    index = valueEnd
  }
}

// ranges of the elements of the array starting at raw[start] === '['
const arrayElements = (raw: string, start: number): Range[] => {
  let index = skipWhitespace(raw, start)
  if (raw[index] !== '[') {
    return []
  }
  index++
  const elements: Range[] = []
  while (true) {
    index = skipWhitespace(raw, index)
    if (index >= raw.length) {
      throw new Error('unterminated array')
    }
    if (raw[index] === ']') {
      return elements
    }
    if (raw[index] === ',') {
      index++
      continue
    }
    const end = skipValue(raw, index)
    elements.push({start: index, end})
    index = end
  }
}

// the raw bytes of each Providers[i].Payload, undefined for a provider that has none.
// the returned array lines up with the parsed body.Providers array
export const extractRawPayloads = (body: Buffer): (Buffer | undefined)[] => {
  const raw = body.toString('latin1')
  let providers: Range | undefined
  try {
    providers = objectMember(raw, 0, 'Providers')
  } catch {
    return []
  }
  if (!providers) {
    return []
  }
  try {
    return arrayElements(raw, providers.start).map((element) => {
      const payload = objectMember(raw, element.start, 'Payload')
      return payload && body.subarray(payload.start, payload.end)
    })
  } catch {
    return []
  }
}
