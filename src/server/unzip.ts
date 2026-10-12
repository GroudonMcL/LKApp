import 'server-only'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'

/**
 * Extracts a .zip file (stored or deflated entries, as made by Windows `tar -a` and `zip`) into a
 * folder, from its central directory. Refuses entries that would land outside the folder
 * (absolute paths, `..`), and checks every file's CRC-32. Sizes and offsets marked as ZIP64
 * (as some zip writers do for streamed entries) are read from the ZIP64 extra field. No
 * encryption, no multi-disk archives.
 */
export function extractZip(zip: Buffer, into: string): { files: number } {
  const root = resolve(into)
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('Not a zip file (no end of central directory).')
  const entries = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  let files = 0
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip file is damaged (central directory).')
    const flags = zip.readUInt16LE(at + 8)
    const method = zip.readUInt16LE(at + 10)
    const crc = zip.readUInt32LE(at + 16)
    let compressedSize = zip.readUInt32LE(at + 20)
    let size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    let localHeader = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/')
    // ZIP64: the real values of fields marked 0xffffffff, in this order, in extra field 0x0001.
    const extra = zip.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
    for (let e = 0; e + 4 <= extra.length; e += 4 + extra.readUInt16LE(e + 2)) {
      if (extra.readUInt16LE(e) !== 0x0001) continue
      let field = e + 4
      const next = () => {
        const value = Number(extra.readBigUInt64LE(field))
        field += 8
        return value
      }
      if (size === 0xffffffff) size = next()
      if (compressedSize === 0xffffffff) compressedSize = next()
      if (localHeader === 0xffffffff) localHeader = next()
    }
    at += 46 + nameLength + extraLength + commentLength

    if (flags & 0x1) throw new Error('The zip file is encrypted.')
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeader === 0xffffffff) throw new Error('The zip file is damaged (ZIP64 sizes missing).')
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) throw new Error(`Refusing a file outside the folder: ${name}`)
    const target = resolve(root, name)
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`Refusing a file outside the folder: ${name}`)
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }

    if (zip.readUInt32LE(localHeader) !== 0x04034b50) throw new Error(`The zip file is damaged (${name}).`)
    const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28)
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`Unsupported compression in ${name}.`)
    if (data.length !== size || crc32(data) >>> 0 !== crc >>> 0) throw new Error(`The zip file is damaged (${name} does not match its checksum).`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    files++
  }
  return { files }
}

/** The folder a zip's paths start with, when they all share one (e.g. "LK Companion"). */
export function zipTopFolder(zip: Buffer): string | null {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) return null
  const entries = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  const tops = new Set<string>()
  for (let i = 0; i < entries; i++) {
    const nameLength = zip.readUInt16LE(at + 28)
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8').replace(/\\/g, '/')
    tops.add(name.split('/')[0]!)
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  return tops.size === 1 ? [...tops][0]! : null
}

