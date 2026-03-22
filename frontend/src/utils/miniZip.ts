/**
 * Pure JS zip builder (STORE method, no compression, with CRC-32).
 * Compatible with macOS Archive Utility, Windows Explorer, etc.
 */

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

export interface ZipFile {
  name: string
  content: string | Uint8Array
}

export function miniZip(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder()
  const entries = files.map(f => {
    const data = typeof f.content === 'string' ? enc.encode(f.content) : f.content
    return { name: enc.encode(f.name), data, crc: crc32(data) }
  })

  let offset = 0
  const localHeaders: { header: Uint8Array; data: Uint8Array }[] = []
  const centralHeaders: Uint8Array[] = []

  entries.forEach(e => {
    const lh = new Uint8Array(30 + e.name.length)
    const dv = new DataView(lh.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(8, 0, true)
    dv.setUint32(14, e.crc, true)
    dv.setUint32(18, e.data.length, true)
    dv.setUint32(22, e.data.length, true)
    dv.setUint16(26, e.name.length, true)
    lh.set(e.name, 30)

    const ch = new Uint8Array(46 + e.name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true)
    cv.setUint32(16, e.crc, true)
    cv.setUint32(20, e.data.length, true)
    cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, e.name.length, true)
    cv.setUint32(42, offset, true)
    ch.set(e.name, 46)

    localHeaders.push({ header: lh, data: e.data })
    centralHeaders.push(ch)
    offset += lh.length + e.data.length
  })

  const centralDirOffset = offset
  let centralDirSize = 0
  centralHeaders.forEach(ch => centralDirSize += ch.length)

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralDirSize, true)
  ev.setUint32(16, centralDirOffset, true)

  const totalSize = offset + centralDirSize + 22
  const result = new Uint8Array(totalSize)
  let pos = 0
  localHeaders.forEach(({ header, data }) => {
    result.set(header, pos); pos += header.length
    result.set(data, pos); pos += data.length
  })
  centralHeaders.forEach(ch => {
    result.set(ch, pos); pos += ch.length
  })
  result.set(eocd, pos)
  return result
}

export function downloadBlob(data: Uint8Array, filename: string, mime: string = 'application/zip') {
  const blob = new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}