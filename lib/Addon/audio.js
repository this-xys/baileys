import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
const u32be = (b, o) => b.readUInt32BE(o);
const u64be = (b, o) => Number(b.readBigUInt64BE(o));
const ascii = (b, o, n) => b.toString('latin1', o, o + n);
const oggDuration = buf => {
    const streams = new Map();
    let pos = 0;
    let endOfStream = false;
    while (true) {
        if (pos + 27 > buf.length) {
            if (pos < buf.length)
                endOfStream = true;
            else
                endOfStream = true;
            break;
        }
        if (ascii(buf, pos, 4) !== 'OggS')
            break;
        const headerType = buf[pos + 5];
        const granule = buf.readBigInt64LE(pos + 6);
        const serial = buf.readUInt32LE(pos + 14);
        const nseg = buf[pos + 26];
        let s = streams.get(serial);
        if (!s) {
            s = { codec: undefined, sampleRate: undefined, preSkip: 0, last: undefined, closed: false, pageNumber: 0, fullPages: 0, pageCount: 0 };
            streams.set(serial, s);
        }
        s.pageNumber = buf.readUInt32LE(pos + 18);
        if (pos + 27 + nseg > buf.length) {
            endOfStream = true;
            break;
        }
        let dataLen = 0;
        for (let i = 0; i < nseg; i++)
            dataLen += buf[pos + 27 + i];
        const dataStart = pos + 27 + nseg;
        if (dataStart + dataLen > buf.length) {
            endOfStream = true;
            break;
        }
        if (headerType & 0x02) {
            const idText = [...buf.subarray(dataStart, dataStart + 7)].filter(b => b >= 32 && b <= 126).map(b => String.fromCharCode(b)).join('');
            if (idText === 'OpusHea') {
                s.codec = 'opus';
                s.preSkip = buf.readUInt16LE(dataStart + 10);
                s.sampleRate = buf.readUInt32LE(dataStart + 12);
            }
            else if (idText === 'vorbis') {
                s.codec = 'vorbis';
                s.sampleRate = buf.readUInt32LE(dataStart + 12);
            }
            else {
                s.codec = 'other';
            }
        }
        if (headerType & 0x04)
            s.closed = true;
        else if (!(headerType & 0x02))
            s.fullPages++;
        s.pageCount++;
        s.last = { granule, lastPage: !!(headerType & 0x04) };
        pos = dataStart + dataLen;
        if ([...streams.values()].every(x => x.closed))
            break;
    }
    for (const s of streams.values()) {
        if (!s.last || !s.sampleRate)
            continue;
        if (!(endOfStream || s.last.lastPage))
            continue;
        if (s.last.granule < 0n)
            continue;
        if (s.codec === 'vorbis' && endOfStream && !s.last.lastPage && s.fullPages === 0 && s.pageCount > 0)
            return undefined;
        const g = Number(s.last.granule);
        if (s.codec === 'opus')
            return (g - s.preSkip) / 48000;
        if (s.codec === 'vorbis')
            return g / s.sampleRate;
    }
    return undefined;
};
const wavDuration = buf => {
    if (ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WAVE')
        return undefined;
    let pos = 12;
    let sampleRate;
    let blockAlign = 0;
    let fact;
    while (pos + 8 <= buf.length) {
        const id = ascii(buf, pos, 4);
        const size = buf.readUInt32LE(pos + 4);
        const body = pos + 8;
        if (id === 'fmt ') {
            sampleRate = buf.readUInt32LE(body + 4);
            blockAlign = buf.readUInt16LE(body + 12);
        }
        else if (id === 'fact') {
            fact = buf.readUInt32LE(body);
        }
        else if (id === 'data') {
            let chunkSize = size;
            const remaining = buf.length - body;
            if (remaining < chunkSize)
                chunkSize = remaining;
            const samples = fact !== undefined ? fact : chunkSize === 0xffffffff ? undefined : chunkSize / blockAlign;
            if (samples && sampleRate)
                return samples / sampleRate;
            return undefined;
        }
        pos = body + size + (size % 2);
    }
    return undefined;
};
const flacDuration = buf => {
    if (ascii(buf, 0, 4) !== 'fLaC')
        return undefined;
    let pos = 4;
    while (pos + 4 <= buf.length) {
        const h = buf[pos];
        const type = h & 0x7f;
        const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
        if (type === 0) {
            if (len !== 34)
                return undefined;
            if (pos + 4 + 34 > buf.length)
                return undefined;
            const o = pos + 4;
            const sampleRate = ((buf[o + 10] << 16) | (buf[o + 11] << 8) | buf[o + 12]) >> 4;
            const totalSamples = (buf[o + 13] & 0x0f) * 2 ** 32 + buf.readUInt32BE(o + 14);
            return totalSamples > 0 && sampleRate ? totalSamples / sampleRate : undefined;
        }
        if (h & 0x80)
            break;
        pos += 4 + len;
    }
    return undefined;
};
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex']);
const mp4Duration = buf => {
    const tracks = [];
    const walk = (start, end, cur) => {
        let pos = start;
        while (pos + 8 <= end) {
            let size = u32be(buf, pos);
            const type = ascii(buf, pos + 4, 4);
            let hdr = 8;
            if (size === 1) {
                size = u64be(buf, pos + 8);
                hdr = 16;
            }
            else if (size === 0)
                size = end - pos;
            if (size >= hdr && pos + size > end) {
                if (type === 'moov')
                    truncated = true;
                size = end - pos;
            }
            else if (size < hdr)
                size = Math.min(Math.max(size, hdr), end - pos);
            const body = pos + hdr;
            const bodyEnd = pos + size;
            if (type === 'trak') {
                const t = { handler: undefined, timeScale: 0, duration: 0, hasMdhd: false };
                tracks.push(t);
                walk(body, bodyEnd, t);
            }
            else if (CONTAINERS.has(type)) {
                walk(body, bodyEnd, cur);
            }
            else if (cur && type === 'hdlr') {
                cur.handler = ascii(buf, body + 8, 4);
            }
            else if (cur && type === 'mdhd') {
                const v = buf[body];
                cur.hasMdhd = true;
                if (v === 1) {
                    cur.timeScale = u32be(buf, body + 20);
                    cur.duration = u64be(buf, body + 24);
                }
                else {
                    cur.timeScale = u32be(buf, body + 12);
                    cur.duration = u32be(buf, body + 16);
                }
            }
            pos += size;
        }
    };
    let truncated = false;
    walk(0, buf.length, undefined);
    if (truncated)
        return undefined;
    const audio = tracks.find(t => t.handler === 'soun' || t.handler === 'audi');
    if (audio && audio.timeScale > 0 && audio.duration > 0)
        return audio.duration / audio.timeScale;
    return undefined;
};
const MPEG_BITRATES = {
    '1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MPEG_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const mpegHeader = (buf, o) => {
    if (o + 4 > buf.length || buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0)
        return null;
    const versionBits = (buf[o + 1] >> 3) & 3;
    const layerBits = (buf[o + 1] >> 1) & 3;
    const bitrateIdx = buf[o + 2] >> 4;
    const srIdx = (buf[o + 2] >> 2) & 3;
    const padding = (buf[o + 2] >> 1) & 1;
    if (versionBits === 1 || layerBits === 0 || srIdx === 3)
        return null;
    const layer = 4 - layerBits;
    const verKey = versionBits === 3 ? 1 : 2;
    if (bitrateIdx === 0 || bitrateIdx === 15)
        return null;
    const bitrate = MPEG_BITRATES[`${verKey}-${layer}`][bitrateIdx - 1] * 1000;
    const sampleRate = MPEG_SAMPLE_RATES[versionBits][srIdx];
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : versionBits === 3 ? 1152 : 576;
    const slot = layer === 1 ? 4 : 1;
    const frameSize = layer === 1 ? Math.floor(((12 * bitrate) / sampleRate + padding) * 4) : Math.floor((samplesPerFrame / 8) * bitrate / sampleRate + (padding ? slot : 0));
    const mono = (buf[o + 3] >> 6) === 3;
    return { versionBits, layer, bitrate, sampleRate, samplesPerFrame, frameSize, padding, crc: (buf[o + 1] & 1) === 0, mono };
};
const id3v2Size = buf => {
    if (buf.length >= 10 && ascii(buf, 0, 3) === 'ID3') {
        const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
        return 10 + size + (buf[5] & 0x10 ? 10 : 0);
    }
    return 0;
};
const mp3Duration = buf => {
    let pos = id3v2Size(buf);
    let first;
    while (pos + 4 <= buf.length) {
        const h = mpegHeader(buf, pos);
        if (h && h.frameSize > 0 && (pos + h.frameSize === buf.length || mpegHeader(buf, pos + h.frameSize) || pos + h.frameSize > buf.length)) {
            first = { ...h, pos };
            break;
        }
        pos++;
    }
    if (!first)
        return undefined;
    const hasId3v1 = buf.length >= 128 && ascii(buf, buf.length - 128, 3) === 'TAG';
    const sideInfo = first.versionBits === 3 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
    const tagOff = first.pos + 4 + (first.crc ? 2 : 0) + sideInfo;
    const tag = tagOff + 4 <= buf.length ? ascii(buf, tagOff, 4) : '';
    if (tag === 'Xing' || tag === 'Info') {
        const flags = u32be(buf, tagOff + 4);
        let o = tagOff + 8;
        let numFrames = null;
        let streamSize = null;
        if (flags & 1) {
            numFrames = u32be(buf, o);
            o += 4;
        }
        if (flags & 2) {
            streamSize = u32be(buf, o);
            o += 4;
        }
        if (flags & 4)
            o += 100;
        if (flags & 8)
            o += 4;
        let lameMusicLength;
        if (o + 4 <= buf.length && ascii(buf, o, 4) === 'LAME') {
            const ver = ascii(buf, o + 4, 5);
            const m = ver.match(/\d+.\d+/g);
            if (m) {
                const [maj, min] = m[0].split('.').map(n => parseInt(n, 10));
                if (maj >= 3 && min >= 90)
                    lameMusicLength = buf.readUInt32BE(o + 9 + 0x14);
            }
        }
        if (streamSize && numFrames !== null)
            return (numFrames * first.samplesPerFrame) / first.sampleRate;
        if (lameMusicLength !== undefined && lameMusicLength > 0)
            return lameMusicLength / 1000;
    }
    const bitrates = [];
    let p = first.pos;
    let last;
    for (let i = 0; i < 4 && p + 4 <= buf.length; i++) {
        const h = mpegHeader(buf, p);
        if (!h)
            break;
        bitrates.push(h.bitrate);
        last = h;
        p += h.frameSize;
    }
    if (bitrates.length === 4 && bitrates.every(b => b === bitrates[0])) {
        const mpegSize = buf.length - first.pos - (hasId3v1 ? 128 : 0);
        return (Math.round(mpegSize / last.frameSize) * first.samplesPerFrame) / first.sampleRate;
    }
    let frames = 0;
    p = first.pos;
    while (p + 4 <= buf.length) {
        const h = mpegHeader(buf, p);
        if (!h) {
            p++;
            continue;
        }
        frames++;
        p += h.frameSize;
    }
    return frames ? (frames * first.samplesPerFrame) / first.sampleRate : undefined;
};
const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const adtsDuration = buf => {
    let pos = id3v2Size(buf);
    let frames = 0;
    let sampleRate;
    while (pos + 7 <= buf.length) {
        if (buf[pos] !== 0xff || (buf[pos + 1] & 0xf6) !== 0xf0) {
            if (frames === 0) {
                pos++;
                continue;
            }
            break;
        }
        const sfi = (buf[pos + 2] >> 2) & 0x0f;
        const frameLength = ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | (buf[pos + 5] >> 5);
        if (sfi > 12 || frameLength < 7) {
            if (frames === 0) {
                pos++;
                continue;
            }
            break;
        }
        if (sampleRate === undefined)
            sampleRate = ADTS_SAMPLE_RATES[sfi];
        frames++;
        pos += frameLength;
    }
    return frames && sampleRate ? (frames * 1024) / sampleRate : undefined;
};
const aiffDuration = buf => {
    if (ascii(buf, 0, 4) !== 'FORM')
        return undefined;
    const kind = ascii(buf, 8, 4);
    if (kind !== 'AIFF' && kind !== 'AIFC')
        return undefined;
    let pos = 12;
    while (pos + 8 <= buf.length) {
        const id = ascii(buf, pos, 4);
        const size = u32be(buf, pos + 4);
        const body = pos + 8;
        if (id === 'COMM') {
            if (size < 18 || body + size > buf.length)
                return undefined;
            const frames = u32be(buf, body + 2);
            const exp = buf.readUInt16BE(body + 8) & 0x7fff;
            const mantissa = buf.readBigUInt64BE(body + 10);
            const sampleRate = Number(mantissa) * 2 ** (exp - 16383 - 63);
            return sampleRate > 0 ? frames / sampleRate : undefined;
        }
        pos = body + size + (size & 1);
    }
    return undefined;
};
const ebmlVint = (buf, pos, keepMarker) => {
    if (pos >= buf.length)
        return undefined;
    const first = buf[pos];
    if (first === 0)
        return undefined;
    const len = Math.clz32(first) - 23;
    if (pos + len > buf.length)
        return undefined;
    let value = keepMarker ? first : first & (0xff >> len);
    let allOnes = (first & (0xff >> len)) === 0xff >> len;
    for (let i = 1; i < len; i++) {
        value = value * 256 + buf[pos + i];
        if (buf[pos + i] !== 0xff)
            allOnes = false;
    }
    return { value, length: len, unknown: !keepMarker && allOnes };
};
const matroskaDuration = buf => {
    const info = { timecodeScale: undefined, duration: undefined };
    const readUInt = (o, n) => {
        let v = 0;
        for (let i = 0; i < n; i++)
            v = v * 256 + buf[o + i];
        return v;
    };
    const walk = (start, end, depth) => {
        let pos = start;
        while (pos < end) {
            const id = ebmlVint(buf, pos, true);
            if (!id)
                return false;
            const size = ebmlVint(buf, pos + id.length, false);
            if (!size)
                return false;
            const body = pos + id.length + size.length;
            const bodyEnd = size.unknown ? end : Math.min(end, body + size.value);
            if (id.value === 0x18538067 && depth === 0) {
                if (walk(body, bodyEnd, 1))
                    return true;
            }
            else if (id.value === 0x1549a966 && depth === 1) {
                let q = body;
                while (q < bodyEnd) {
                    const cid = ebmlVint(buf, q, true);
                    const csz = cid && ebmlVint(buf, q + cid.length, false);
                    if (!csz)
                        break;
                    const cb = q + cid.length + csz.length;
                    if (cb + csz.value > buf.length)
                        break;
                    if (cid.value === 0x2ad7b1)
                        info.timecodeScale = readUInt(cb, csz.value);
                    else if (cid.value === 0x4489)
                        info.duration = csz.value === 4 ? buf.readFloatBE(cb) : csz.value === 8 ? buf.readDoubleBE(cb) : undefined;
                    q = cb + csz.value;
                }
                return true;
            }
            if (size.unknown)
                return false;
            pos = body + size.value;
        }
        return false;
    };
    walk(0, buf.length, 0);
    if (typeof info.duration !== 'number' || !Number.isFinite(info.duration))
        return undefined;
    return (info.duration * (info.timecodeScale || 1000000)) / 1e9;
};
const AMR_NB_FRAME_BYTES = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1];
const AMR_WB_FRAME_BYTES = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 0, 0, 0, 0, 1, 1];
const amrDuration = buf => {
    const wb = ascii(buf, 0, 9) === '#!AMR-WB\n';
    if (!wb && ascii(buf, 0, 6) !== '#!AMR\n')
        return undefined;
    const table = wb ? AMR_WB_FRAME_BYTES : AMR_NB_FRAME_BYTES;
    let pos = wb ? 9 : 6;
    let frames = 0;
    while (pos < buf.length) {
        const size = table[(buf[pos] >> 3) & 0x0f];
        if (!size)
            break;
        if (pos + size > buf.length)
            break;
        frames++;
        pos += size;
    }
    return frames ? frames * 0.02 : undefined;
};
export const durationFromBuffer = buf => {
    if (!Buffer.isBuffer(buf))
        buf = Buffer.from(buf);
    if (buf.length < 12)
        return undefined;
    try {
        const magic = ascii(buf, 0, 4);
        if (magic === 'OggS')
            return oggDuration(buf);
        if (magic === 'RIFF')
            return wavDuration(buf);
        if (magic === 'fLaC')
            return flacDuration(buf);
        if (ascii(buf, 4, 4) === 'ftyp')
            return mp4Duration(buf);
        if (magic === 'FORM')
            return aiffDuration(buf);
        if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
            return matroskaDuration(buf);
        if (magic === '#!AM')
            return amrDuration(buf);
        if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0)
            return adtsDuration(buf);
        if (magic.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))
            return mp3Duration(buf);
    }
    catch {
        return undefined;
    }
    return undefined;
};
export const audioDuration = async (input) => {
    if (Buffer.isBuffer(input))
        return durationFromBuffer(input);
    if (typeof input === 'string') {
        const { size } = await stat(input);
        if (size > 64 * 1024 * 1024) {
            const fh = await open(input, 'r');
            try {
                const head = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
                await fh.read(head, 0, head.length, 0);
                return durationFromBuffer(head);
            }
            finally {
                await fh.close();
            }
        }
        const chunks = [];
        for await (const c of createReadStream(input))
            chunks.push(c);
        return durationFromBuffer(Buffer.concat(chunks));
    }
    const chunks = [];
    for await (const c of input)
        chunks.push(c);
    return durationFromBuffer(Buffer.concat(chunks));
};
function decodeWav(buf) {
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE')
        return undefined;
    let pos = 12;
    let fmt;
    while (pos + 8 <= buf.length) {
        const id = buf.toString('latin1', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        const body = pos + 8;
        if (id === 'fmt ') {
            let tag = buf.readUInt16LE(body);
            const bits = buf.readUInt16LE(body + 14);
            if (tag === 0xfffe && size >= 26)
                tag = buf.readUInt16LE(body + 24);
            fmt = { tag, channels: buf.readUInt16LE(body + 2), blockAlign: buf.readUInt16LE(body + 12), bits };
        }
        else if (id === 'data') {
            if (!fmt || !fmt.channels || !fmt.blockAlign)
                return undefined;
            const end = Math.min(buf.length, size === 0xffffffff ? buf.length : body + size);
            const frames = Math.floor((end - body) / fmt.blockAlign);
            const bytes = fmt.bits >> 3;
            const out = new Float32Array(frames);
            for (let i = 0; i < frames; i++) {
                const o = body + i * fmt.blockAlign;
                let v;
                if (fmt.tag === 1) {
                    if (fmt.bits === 8)
                        v = (buf[o] - 128) / 128;
                    else if (fmt.bits === 16)
                        v = buf.readInt16LE(o) / 32768;
                    else if (fmt.bits === 24)
                        v = buf.readIntLE(o, 3) / 8388608;
                    else if (fmt.bits === 32)
                        v = buf.readInt32LE(o) / 2147483648;
                    else
                        return undefined;
                }
                else if (fmt.tag === 3) {
                    if (bytes === 4)
                        v = buf.readFloatLE(o);
                    else if (bytes === 8)
                        v = buf.readDoubleLE(o);
                    else
                        return undefined;
                }
                else
                    return undefined;
                out[i] = v;
            }
            return out;
        }
        pos = body + size + (size & 1);
    }
    return undefined;
}
class Bits {
    constructor(buf, pos) {
        this.buf = buf;
        this.pos = pos * 8;
    }
    get bytePos() {
        return this.pos >> 3;
    }
    read(n) {
        let v = 0;
        while (n > 0) {
            const byte = this.buf[this.pos >> 3];
            if (byte === undefined)
                throw new Error('FLAC: unexpected end of data');
            const avail = 8 - (this.pos & 7);
            const take = Math.min(avail, n);
            v = v * (1 << take) + ((byte >> (avail - take)) & ((1 << take) - 1));
            this.pos += take;
            n -= take;
        }
        return v;
    }
    readSigned(n) {
        const v = this.read(n);
        return v >= 2 ** (n - 1) ? v - 2 ** n : v;
    }
    unary() {
        let n = 0;
        while (this.read(1) === 0)
            n++;
        return n;
    }
    align() {
        this.pos = (this.pos + 7) & ~7;
    }
}
const FIXED = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];
const BLOCK_SIZES = { 1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608, 8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096, 13: 8192, 14: 16384, 15: 32768 };
const SAMPLE_BITS = { 1: 8, 2: 12, 4: 16, 5: 20, 6: 24, 7: 32 };
function readResidual(br, out, offset, blockSize, order) {
    const method = br.read(2);
    if (method > 1)
        throw new Error('FLAC: bad residual coding method');
    const paramBits = method === 0 ? 4 : 5;
    const escape = method === 0 ? 15 : 31;
    const partOrder = br.read(4);
    const parts = 1 << partOrder;
    let n = offset + order;
    for (let p = 0; p < parts; p++) {
        const count = (blockSize >> partOrder) - (p === 0 ? order : 0);
        const param = br.read(paramBits);
        if (param === escape) {
            const bits = br.read(5);
            for (let i = 0; i < count; i++)
                out[n++] = bits ? br.readSigned(bits) : 0;
        }
        else {
            for (let i = 0; i < count; i++) {
                const q = br.unary();
                const r = param ? br.read(param) : 0;
                const u = q * 2 ** param + r;
                out[n++] = u % 2 === 0 ? u / 2 : -(u + 1) / 2;
            }
        }
    }
}
function readSubframe(br, blockSize, bps) {
    br.read(1);
    const type = br.read(6);
    let wasted = 0;
    if (br.read(1))
        wasted = br.unary() + 1;
    const bits = bps - wasted;
    const s = new Float64Array(blockSize);
    if (type === 0) {
        const v = br.readSigned(bits);
        s.fill(v);
    }
    else if (type === 1) {
        for (let i = 0; i < blockSize; i++)
            s[i] = br.readSigned(bits);
    }
    else if (type >= 8 && type <= 12) {
        const order = type - 8;
        for (let i = 0; i < order; i++)
            s[i] = br.readSigned(bits);
        readResidual(br, s, 0, blockSize, order);
        const c = FIXED[order];
        for (let i = order; i < blockSize; i++) {
            let pred = 0;
            for (let j = 0; j < order; j++)
                pred += c[j] * s[i - 1 - j];
            s[i] += pred;
        }
    }
    else if (type >= 32) {
        const order = type - 31;
        for (let i = 0; i < order; i++)
            s[i] = br.readSigned(bits);
        const precision = br.read(4) + 1;
        if (precision === 16)
            throw new Error('FLAC: invalid LPC precision');
        const shift = br.readSigned(5);
        const coefs = [];
        for (let i = 0; i < order; i++)
            coefs.push(br.readSigned(precision));
        readResidual(br, s, 0, blockSize, order);
        const div = 2 ** shift;
        for (let i = order; i < blockSize; i++) {
            let sum = 0;
            for (let j = 0; j < order; j++)
                sum += coefs[j] * s[i - 1 - j];
            s[i] += shift >= 0 ? Math.floor(sum / div) : sum * 2 ** -shift;
        }
    }
    else
        throw new Error('FLAC: reserved subframe type');
    if (wasted)
        for (let i = 0; i < blockSize; i++)
            s[i] *= 2 ** wasted;
    return s;
}
function decodeFlac(buf) {
    if (buf.toString('latin1', 0, 4) !== 'fLaC')
        return undefined;
    let pos = 4;
    let streamBps = 0;
    let total = 0;
    while (pos + 4 <= buf.length) {
        const h = buf[pos];
        const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
        if ((h & 0x7f) === 0 && len === 34) {
            streamBps = ((buf[pos + 4 + 12] & 1) << 4) + (buf[pos + 4 + 13] >> 4) + 1;
            total = (buf[pos + 4 + 13] & 15) * 2 ** 32 + buf.readUInt32BE(pos + 4 + 14);
        }
        pos += 4 + len;
        if (h & 0x80)
            break;
    }
    if (!streamBps)
        return undefined;
    const chunks = [];
    let count = 0;
    const br = new Bits(buf, pos);
    while (br.bytePos + 6 < buf.length) {
        const sync = br.read(14);
        if (sync !== 0x3ffe)
            break;
        br.read(2);
        const bsCode = br.read(4);
        const srCode = br.read(4);
        const chAssign = br.read(4);
        const sizeCode = br.read(3);
        br.read(1);
        const first = br.read(8);
        let extra = first < 0x80 ? 0 : first < 0xe0 ? 1 : first < 0xf0 ? 2 : first < 0xf8 ? 3 : first < 0xfc ? 4 : first < 0xfe ? 5 : 6;
        while (extra-- > 0)
            br.read(8);
        let blockSize = BLOCK_SIZES[bsCode];
        if (bsCode === 6)
            blockSize = br.read(8) + 1;
        else if (bsCode === 7)
            blockSize = br.read(16) + 1;
        if (!blockSize)
            throw new Error('FLAC: bad block size');
        if (srCode === 12)
            br.read(8);
        else if (srCode === 13 || srCode === 14)
            br.read(16);
        br.read(8);
        const bps = sizeCode === 0 ? streamBps : SAMPLE_BITS[sizeCode];
        if (!bps)
            throw new Error('FLAC: reserved sample size');
        const nch = chAssign < 8 ? chAssign + 1 : 2;
        const chans = [];
        for (let c = 0; c < nch; c++) {
            const extraBit = (chAssign === 8 && c === 1) || (chAssign === 9 && c === 0) || (chAssign === 10 && c === 1) ? 1 : 0;
            chans.push(readSubframe(br, blockSize, bps + extraBit));
        }
        br.align();
        br.read(16);
        let ch0 = chans[0];
        if (chAssign === 8)
            ch0 = chans[0];
        else if (chAssign === 9) {
            ch0 = new Float64Array(blockSize);
            for (let i = 0; i < blockSize; i++)
                ch0[i] = chans[0][i] + chans[1][i];
        }
        else if (chAssign === 10) {
            ch0 = new Float64Array(blockSize);
            for (let i = 0; i < blockSize; i++) {
                const side = chans[1][i];
                const mid = chans[0][i] * 2 + (((side % 2) + 2) % 2);
                ch0[i] = (mid + side) / 2;
            }
        }
        const scale = 2 ** (bps - 1);
        const f = new Float32Array(blockSize);
        for (let i = 0; i < blockSize; i++)
            f[i] = ch0[i] / scale;
        chunks.push(f);
        count += blockSize;
    }
    const out = new Float32Array(count);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return total && count > total ? out.subarray(0, total) : out;
}
export function decodeChannel0(buffer) {
    if (!Buffer.isBuffer(buffer))
        buffer = Buffer.from(buffer);
    if (buffer.length < 12)
        return undefined;
    try {
        return decodeWav(buffer) ?? decodeFlac(buffer);
    }
    catch {
        return undefined;
    }
}
export function waveformFromSamples(rawData, samples = 64) {
    const blockSize = Math.floor(rawData.length / samples);
    const filtered = [];
    for (let i = 0; i < samples; i++) {
        const blockStart = blockSize * i;
        let sum = 0;
        for (let j = 0; j < blockSize; j++)
            sum += Math.abs(rawData[blockStart + j]);
        filtered.push(sum / blockSize);
    }
    const multiplier = Math.pow(Math.max(...filtered), -1);
    return new Uint8Array(filtered.map(n => n * multiplier).map(n => Math.floor(100 * n)));
}
const toBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream)
        chunks.push(chunk);
    return Buffer.concat(chunks);
};
const decodeChannel0WithFfmpeg = audioData => new Promise(resolve => {
    let child;
    try {
        child = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-af', 'pan=mono|c0=c0', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    }
    catch {
        return resolve(undefined);
    }
    const out = [];
    const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(undefined);
    }, 60000);
    child.on('error', () => resolve(undefined));
    child.stdin.on('error', () => { });
    child.stdout.on('data', c => out.push(c));
    child.on('close', code => {
        clearTimeout(timer);
        const raw = Buffer.concat(out);
        if (code !== 0 || raw.length < 4)
            return resolve(undefined);
        const samples = new Float32Array(Math.floor(raw.length / 4));
        for (let i = 0; i < samples.length; i++)
            samples[i] = raw.readFloatLE(i * 4);
        resolve(samples);
    });
    child.stdin.end(audioData);
});
const ffprobeDuration = async (input) => {
    const usesStdin = Buffer.isBuffer(input);
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', usesStdin ? 'pipe:0' : input];
    try {
        const ffprobe = spawn('ffprobe', args, { stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
        const out = [];
        ffprobe.stdout.on('data', chunk => out.push(chunk));
        ffprobe.stdin?.on('error', () => { });
        if (usesStdin)
            ffprobe.stdin.end(input);
        const [code] = await once(ffprobe, 'close');
        if (code !== 0)
            return undefined;
        const seconds = parseFloat(Buffer.concat(out).toString('utf8').trim());
        return Number.isFinite(seconds) ? seconds : undefined;
    }
    catch {
        return undefined;
    }
};
const getDuration = async (audioData) => {
    const native = await audioDuration(audioData).catch(() => undefined);
    if (typeof native === 'number' && Number.isFinite(native))
        return Math.round(native);
    const probed = await ffprobeDuration(audioData);
    return probed === undefined ? undefined : Math.round(probed);
};
export async function getAudioWaveform(input, logger) {
    let audioData;
    if (Buffer.isBuffer(input))
        audioData = input;
    else if (typeof input === 'string')
        audioData = await toBuffer(createReadStream(input));
    else
        audioData = await toBuffer(input);
    let waveform;
    try {
        const rawData = decodeChannel0(audioData) ?? (await decodeChannel0WithFfmpeg(audioData));
        if (rawData && rawData.length)
            waveform = waveformFromSamples(rawData);
        else
            logger?.debug('Failed to generate waveform: no decoder for this audio');
    }
    catch (e) {
        logger?.debug('Failed to generate waveform: ' + e);
    }
    const durationSeconds = await getDuration(audioData);
    return { durationSeconds, waveform };
}
