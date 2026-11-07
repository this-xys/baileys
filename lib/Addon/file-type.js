import { open } from 'node:fs/promises';
const HEAD_BYTES = 8192;
const ascii = (b, o, n) => b.toString('latin1', o, o + n);
const startsWith = (b, bytes, offset = 0) => {
    if (b.length < offset + bytes.length)
        return false;
    for (let i = 0; i < bytes.length; i++) {
        if (b[offset + i] !== bytes[i])
            return false;
    }
    return true;
};
const FTYP_BRANDS = {
    'heic': ['image/heic', 'heic'],
    'heix': ['image/heic', 'heic'],
    'hevc': ['image/heic', 'heic'],
    'hevx': ['image/heic', 'heic'],
    'mif1': ['image/heif', 'heif'],
    'msf1': ['image/heif', 'heif'],
    'avif': ['image/avif', 'avif'],
    'avis': ['image/avif', 'avif'],
    'qt  ': ['video/quicktime', 'mov'],
    'M4A ': ['audio/mp4', 'm4a'],
    'M4B ': ['audio/mp4', 'm4b'],
    'M4V ': ['video/x-m4v', 'm4v'],
    '3gp4': ['video/3gpp', '3gp'],
    '3gp5': ['video/3gpp', '3gp'],
    '3gp6': ['video/3gpp', '3gp'],
    '3gp7': ['video/3gpp', '3gp'],
    '3ge6': ['video/3gpp', '3gp'],
    '3ge7': ['video/3gpp', '3gp'],
    '3gg6': ['video/3gpp', '3gp'],
    '3g2a': ['video/3gpp2', '3g2'],
    '3g2b': ['video/3gpp2', '3g2'],
    '3g2c': ['video/3gpp2', '3g2']
};
const detectZip = (b) => {
    if (b.includes('[Content_Types].xml')) {
        if (b.includes('word/'))
            return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
        if (b.includes('xl/'))
            return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
        if (b.includes('ppt/'))
            return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' };
    }
    if (b.includes('mimetypeapplication/epub+zip'))
        return { mime: 'application/epub+zip', ext: 'epub' };
    if (b.includes('mimetypeapplication/vnd.oasis.opendocument.text'))
        return { mime: 'application/vnd.oasis.opendocument.text', ext: 'odt' };
    if (b.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet'))
        return { mime: 'application/vnd.oasis.opendocument.spreadsheet', ext: 'ods' };
    if (b.includes('mimetypeapplication/vnd.oasis.opendocument.presentation'))
        return { mime: 'application/vnd.oasis.opendocument.presentation', ext: 'odp' };
    if (b.includes('AndroidManifest.xml'))
        return { mime: 'application/vnd.android.package-archive', ext: 'apk' };
    return { mime: 'application/zip', ext: 'zip' };
};
const detectFromBuffer = (b) => {
    if (!b || b.length < 4)
        return {};
    if (startsWith(b, [0xff, 0xd8, 0xff]))
        return { mime: 'image/jpeg', ext: 'jpg' };
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return { mime: 'image/png', ext: 'png' };
    if (ascii(b, 0, 4) === 'GIF8')
        return { mime: 'image/gif', ext: 'gif' };
    if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]))
        return { mime: 'image/tiff', ext: 'tiff' };
    if (b.length >= 14 && b[0] === 0x42 && b[1] === 0x4d && b.readUInt32LE(6) === 0)
        return { mime: 'image/bmp', ext: 'bmp' };
    if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
        const kind = ascii(b, 8, 4);
        if (kind === 'WEBP')
            return { mime: 'image/webp', ext: 'webp' };
        if (kind === 'WAVE')
            return { mime: 'audio/wav', ext: 'wav' };
        if (kind === 'AVI ')
            return { mime: 'video/x-msvideo', ext: 'avi' };
    }
    if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
        const brand = ascii(b, 8, 4);
        const known = FTYP_BRANDS[brand];
        if (known)
            return { mime: known[0], ext: known[1] };
        return { mime: 'video/mp4', ext: 'mp4' };
    }
    if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
        const head = b.subarray(0, 64).toString('latin1');
        return head.includes('webm')
            ? { mime: 'video/webm', ext: 'webm' }
            : { mime: 'video/x-matroska', ext: 'mkv' };
    }
    if (ascii(b, 0, 3) === 'FLV' && b[3] === 0x01)
        return { mime: 'video/x-flv', ext: 'flv' };
    if (startsWith(b, [0x00, 0x00, 0x01, 0xba]) || startsWith(b, [0x00, 0x00, 0x01, 0xb3]))
        return { mime: 'video/mpeg', ext: 'mpg' };
    if (ascii(b, 0, 4) === 'OggS') {
        const head = b.subarray(0, 256).toString('latin1');
        if (head.includes('OpusHead'))
            return { mime: 'audio/ogg; codecs=opus', ext: 'ogg' };
        if (head.includes('theora'))
            return { mime: 'video/ogg', ext: 'ogv' };
        return { mime: 'audio/ogg', ext: 'ogg' };
    }
    if (ascii(b, 0, 4) === 'fLaC')
        return { mime: 'audio/flac', ext: 'flac' };
    if (ascii(b, 0, 8) === '#!AMR-WB')
        return { mime: 'audio/amr-wb', ext: 'awb' };
    if (ascii(b, 0, 5) === '#!AMR')
        return { mime: 'audio/amr', ext: 'amr' };
    if (ascii(b, 0, 4) === 'FORM' && b.length >= 12 && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC'))
        return { mime: 'audio/aiff', ext: 'aiff' };
    if (ascii(b, 0, 4) === 'MThd')
        return { mime: 'audio/midi', ext: 'mid' };
    if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0)
        return { mime: 'audio/aac', ext: 'aac' };
    if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0))
        return { mime: 'audio/mpeg', ext: 'mp3' };
    if (ascii(b, 0, 5) === '%PDF-')
        return { mime: 'application/pdf', ext: 'pdf' };
    if (ascii(b, 0, 5) === '{\\rtf')
        return { mime: 'application/rtf', ext: 'rtf' };
    if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]))
        return detectZip(b);
    if (startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))
        return { mime: 'application/vnd.rar', ext: 'rar' };
    if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
        return { mime: 'application/x-7z-compressed', ext: '7z' };
    if (startsWith(b, [0x1f, 0x8b, 0x08]))
        return { mime: 'application/gzip', ext: 'gz' };
    if (ascii(b, 0, 15) === 'SQLite format 3')
        return { mime: 'application/vnd.sqlite3', ext: 'sqlite' };
    return {};
};
export const detectFileType = async (input) => {
    try {
        if (input == null)
            return {};
        if (typeof input === 'string') {
            const handle = await open(input, 'r');
            try {
                const buffer = Buffer.alloc(HEAD_BYTES);
                const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
                return detectFromBuffer(buffer.subarray(0, bytesRead));
            }
            finally {
                await handle.close();
            }
        }
        if (Buffer.isBuffer(input))
            return detectFromBuffer(input.subarray(0, HEAD_BYTES));
        if (input instanceof Uint8Array || input instanceof ArrayBuffer)
            return detectFromBuffer(Buffer.from(input).subarray(0, HEAD_BYTES));
        return {};
    }
    catch {
        return {};
    }
};
