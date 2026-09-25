/**
 * 最小 zip 读取(WP-F 数据层):只为 OKX / 币安月度资金费归档服务,不引依赖。
 * 按 EOCD → central directory 找条目(不信 local header 里的尺寸,流式写出的 zip 那里可能是 0),支持 method 0(stored)/8(deflate),
 * 用 node:zlib 的 inflateRawSync 解压并校验 CRC32。不支持 zip64 / 加密 / 分卷,遇到直接抛错而不是给半截数据。
 */
import { inflateRawSync, crc32 } from 'node:zlib';
export interface ZipEntry { name: string; method: number; size: number; data: Buffer }
const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
/** 解出 zip 内全部文件条目(目录条目跳过)。 */
export function readZipEntries(input: Uint8Array): ZipEntry[] {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 22) throw new Error('zip_invalid: too_short');
  // EOCD 在末尾,后面最多跟 65535 字节注释;从后往前找签名
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip_invalid: no_eocd');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error('zip_unsupported: zip64');
  if (cdOff + cdSize > buf.length) throw new Error('zip_invalid: central_directory_out_of_range');
  const out: ZipEntry[] = []; let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error('zip_invalid: bad_central_entry');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), locOff = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen); p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`zip_unsupported: encrypted ${name}`);
    if (csize === 0xffffffff || usize === 0xffffffff || locOff === 0xffffffff) throw new Error('zip_unsupported: zip64');
    if (buf.readUInt32LE(locOff) !== LOC) throw new Error(`zip_invalid: bad_local_header ${name}`);
    const start = locOff + 30 + buf.readUInt16LE(locOff + 26) + buf.readUInt16LE(locOff + 28);
    if (start + csize > buf.length) throw new Error(`zip_invalid: truncated ${name}`);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw); else if (method === 8) data = inflateRawSync(raw); else throw new Error(`zip_unsupported: method_${method} ${name}`);
    if (data.length !== usize) throw new Error(`zip_invalid: size_mismatch ${name}`);
    if ((crc32(data) >>> 0) !== crc) throw new Error(`zip_invalid: crc_mismatch ${name}`);
    out.push({ name, method, size: usize, data });
  }
  return out;
}
/** 取第一个满足 pick 的条目(缺省:第一个 .csv)解成 utf8 文本;没有就抛错。 */
export function readZipText(input: Uint8Array, pick: (name: string) => boolean = (n) => n.toLowerCase().endsWith('.csv')): { name: string; text: string } {
  const e = readZipEntries(input).find((x) => pick(x.name)); if (!e) throw new Error('zip_invalid: entry_not_found');
  return { name: e.name, text: e.data.toString('utf8') };
}
