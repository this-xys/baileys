import { Buffer } from 'buffer';
import fs from 'fs/promises';
import { Readable } from 'stream';
import { streamToBuffer } from './streamToBuffer.js';

async function audioToBuffer(audio) {
    if (Buffer.isBuffer(audio)) {
        return audio;
    }

    if (typeof audio === 'string') {
        if (/^https?:\/\//.test(audio)) {
            const res = await fetch(audio);
            return Buffer.from(await res.arrayBuffer());
        }
        return fs.readFile(audio);
    }

    if (audio instanceof Readable) {
        return streamToBuffer(audio);
    }

    throw new TypeError('Unsupported audio input type');
}

export { audioToBuffer };