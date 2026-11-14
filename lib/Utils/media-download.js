import * as Crypto from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Boom } from '../Addon/cache.js';
const BLOCK_SIZE = 16;
const MAC_LENGTH = 10;
const EMPTY = Buffer.alloc(0);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30000;
const DEFAULT_TOTAL_TIMEOUT_MS = 900000;
const DEFAULT_HEADER_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_HIGH_WATER_MARK = 256 * 1024;
const floorToBlock = (num) => Math.floor(num / BLOCK_SIZE) * BLOCK_SIZE;
export const toBytes = (value) => {
    if (!value) {
        return undefined;
    }
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === 'string') {
        const decoded = Buffer.from(value, 'base64');
        return decoded.length ? decoded : undefined;
    }
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
    }
    return undefined;
};
const toDigest = (value) => {
    const bytes = toBytes(value);
    return bytes && bytes.length === 32 ? bytes : undefined;
};
export const toLength = (value) => {
    if (value === undefined || value === null) {
        return undefined;
    }
    let num;
    if (typeof value === 'number') {
        num = value;
    }
    else if (typeof value === 'bigint' || typeof value === 'string') {
        num = Number(value);
    }
    else if (typeof value.toNumber === 'function') {
        num = value.toNumber();
    }
    else if (typeof value.low === 'number' && typeof value.high === 'number') {
        num = value.high * 4294967296 + (value.low >>> 0);
    }
    else {
        return undefined;
    }
    return Number.isFinite(num) && num > 0 ? num : undefined;
};
const normalizeHeaders = (headers) => {
    if (!headers) {
        return {};
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }
    return { ...headers };
};
const parseRetryAfter = (value) => {
    if (!value) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
        return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
    }
    return undefined;
};
const abortReason = (signal) => signal.reason instanceof Error ? signal.reason : new Boom('Media download aborted', { statusCode: 499 });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
        reject(abortReason(signal));
        return;
    }
    const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
});
let sharedAgents;
const getAgent = (protocol) => {
    sharedAgents ??= {
        'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 16 }),
        'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 16 })
    };
    return sharedAgents[protocol];
};
const nodeRequest = (target, headers, ctx, redirects = 0) => new Promise((resolve, reject) => {
    const url = new URL(target);
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, {
        method: 'GET',
        headers,
        agent: ctx.agent ?? getAgent(url.protocol),
        signal: ctx.signal
    }, res => {
        req.setTimeout(0);
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects < ctx.maxRedirects) {
            res.resume();
            resolve(nodeRequest(new URL(location, url).toString(), headers, ctx, redirects + 1));
            return;
        }
        resolve({ status, headers: res.headers, body: res });
    });
    req.setTimeout(ctx.headerTimeoutMs, () => req.destroy(new Error('Media request timed out')));
    req.on('error', reject);
    req.end();
});
const fetchRequest = async (target, headers, ctx) => {
    const response = await fetch(target, {
        dispatcher: ctx.dispatcher,
        method: 'GET',
        headers,
        signal: ctx.signal
    });
    return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: response.body ? Readable.fromWeb(response.body) : Readable.from([])
    };
};
const discardBody = (body, headers) => {
    const length = Number(headers['content-length']);
    if (body.resume && Number.isFinite(length) && length <= 65536) {
        body.resume();
    }
    else {
        body.destroy();
    }
};
const isRetryable = (err, signal) => {
    if (signal.aborted) {
        return false;
    }
    if (err?.isBoom) {
        return RETRYABLE_STATUS.has(err.output.statusCode);
    }
    if (err?.name === 'AbortError' || err?.code === 'ERR_INVALID_URL') {
        return false;
    }
    return true;
};
const buildTarget = (st) => {
    if (st.hosts.length < 2) {
        return st.url;
    }
    const url = new URL(st.url);
    url.host = st.hosts[st.hostIndex % st.hosts.length];
    return url.toString();
};
const buildHeaders = (st, start) => {
    const headers = { ...st.baseHeaders };
    if (start || st.endChunk) {
        headers.Range = `bytes=${start}-${st.endChunk ?? ''}`;
    }
    return headers;
};
const openUpstream = async (st, start) => {
    for (;;) {
        if (st.signal.aborted) {
            throw abortReason(st.signal);
        }
        try {
            const request = st.dispatcher ? fetchRequest : nodeRequest;
            const response = await request(buildTarget(st), buildHeaders(st, start), st);
            if (response.status === 200 || response.status === 206) {
                return { body: response.body, skip: response.status === 200 ? start : 0 };
            }
            discardBody(response.body, response.headers);
            const error = new Boom(`Failed to fetch stream from ${st.url}`, {
                statusCode: response.status,
                data: { url: st.url }
            });
            error.retryAfterMs = parseRetryAfter(response.headers['retry-after']);
            throw error;
        }
        catch (err) {
            if (!isRetryable(err, st.signal) || ++st.failures > st.maxRetries) {
                throw err;
            }
            st.hostIndex++;
            await sleep(err.retryAfterMs ?? Math.min(st.retryDelayMs * st.failures, st.maxRetryDelayMs), st.signal);
        }
    }
};
const integrityError = (message, data) => new Boom(message, { statusCode: 470, data });
const createDecryptor = (st) => {
    const { cipherKey, iv, macKey } = st.keys;
    const verifying = st.verify !== 'none';
    const hmac = verifying && macKey ? Crypto.createHmac('sha256', macKey) : null;
    const encHash = st.encSha256 ? Crypto.createHash('sha256') : null;
    const plainHash = st.fileSha256 ? Crypto.createHash('sha256') : null;
    let decipher = null;
    let ivPrefix = st.firstBlockIsIV ? EMPTY : null;
    let carry = EMPTY;
    let rawReceived = 0;
    let produced = 0;
    let bytesFetched = st.bytesFetched;
    const startDecipher = (ivValue) => {
        decipher = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
        if (st.endByte) {
            decipher.setAutoPadding(false);
        }
        if (hmac) {
            hmac.update(ivValue);
        }
    };
    if (ivPrefix === null) {
        startDecipher(iv);
    }
    const emit = (plain, out) => {
        if (!plain.length) {
            return;
        }
        if (plainHash) {
            plainHash.update(plain);
        }
        produced += plain.length;
        if (!st.ranged) {
            out.push(plain);
            return;
        }
        const wantedStart = st.startByte ?? 0;
        const start = bytesFetched >= wantedStart ? undefined : Math.max(wantedStart - bytesFetched, 0);
        const end = st.endByte && bytesFetched + plain.length >= st.endByte ? Math.max(st.endByte - bytesFetched, 0) : undefined;
        const sliced = plain.subarray(start, end);
        bytesFetched += plain.length;
        if (sliced.length) {
            out.push(sliced);
        }
    };
    const decrypt = (buffer, out) => {
        if (hmac) {
            hmac.update(buffer);
        }
        emit(decipher.update(buffer), out);
    };
    return {
        offset: () => st.startChunk + rawReceived,
        push(chunk) {
            const out = [];
            rawReceived += chunk.length;
            if (encHash) {
                encHash.update(chunk);
            }
            if (!decipher) {
                const need = BLOCK_SIZE - ivPrefix.length;
                if (chunk.length < need) {
                    ivPrefix = Buffer.concat([ivPrefix, chunk]);
                    return out;
                }
                const ivValue = ivPrefix.length ? Buffer.concat([ivPrefix, chunk.subarray(0, need)]) : chunk.subarray(0, need);
                chunk = chunk.subarray(need);
                startDecipher(Buffer.from(ivValue));
            }
            if (carry.length) {
                const need = BLOCK_SIZE - carry.length;
                if (chunk.length < need) {
                    carry = Buffer.concat([carry, chunk]);
                    return out;
                }
                const block = Buffer.concat([carry, chunk.subarray(0, need)]);
                chunk = chunk.subarray(need);
                carry = EMPTY;
                decrypt(block, out);
            }
            const aligned = chunk.length - (chunk.length % BLOCK_SIZE);
            if (aligned) {
                decrypt(chunk.subarray(0, aligned), out);
            }
            if (aligned < chunk.length) {
                carry = Buffer.from(chunk.subarray(aligned));
            }
            return out;
        },
        finish() {
            const out = [];
            if (!decipher) {
                throw new Boom('Downloaded media is empty (no data received)', {
                    statusCode: 470,
                    data: { plainBytesOut: 0, expectedLength: st.expectedLength }
                });
            }
            if (verifying) {
                if (carry.length !== MAC_LENGTH) {
                    throw integrityError('Downloaded media is incomplete (missing MAC)', { received: rawReceived });
                }
                if (hmac && !Crypto.timingSafeEqual(hmac.digest().subarray(0, MAC_LENGTH), carry)) {
                    throw integrityError('Downloaded media failed HMAC validation', { reason: 'hmac' });
                }
                if (encHash && !encHash.digest().equals(st.encSha256)) {
                    throw integrityError('Downloaded media failed encrypted SHA256 validation', { reason: 'enc-sha256' });
                }
            }
            emit(decipher.final(), out);
            if (plainHash && !plainHash.digest().equals(st.fileSha256)) {
                throw integrityError('Downloaded media failed SHA256 validation', { reason: 'sha256' });
            }
            if (st.expectedLength !== undefined && !st.ranged && produced !== st.expectedLength) {
                throw integrityError(`Downloaded media is incomplete: got ${produced} of ${st.expectedLength} bytes`, {
                    plainBytesOut: produced,
                    expectedLength: st.expectedLength
                });
            }
            return out;
        }
    };
};
async function* run(st, dec, first) {
    let current = first;
    try {
        for (;;) {
            const iterator = current.body[Symbol.asyncIterator]();
            let skip = current.skip;
            let failure = null;
            for (;;) {
                let step;
                try {
                    step = await iterator.next();
                }
                catch (err) {
                    failure = err;
                    break;
                }
                if (step.done) {
                    break;
                }
                let chunk = step.value;
                if (skip) {
                    if (chunk.length <= skip) {
                        skip -= chunk.length;
                        continue;
                    }
                    chunk = chunk.subarray(skip);
                    skip = 0;
                }
                st.failures = 0;
                for (const piece of dec.push(chunk)) {
                    yield piece;
                }
            }
            if (!failure) {
                break;
            }
            current.body.destroy();
            if (st.signal.aborted) {
                throw abortReason(st.signal);
            }
            if (!isRetryable(failure, st.signal) || ++st.failures > st.maxRetries) {
                throw failure;
            }
            st.hostIndex++;
            await sleep(Math.min(st.retryDelayMs * st.failures, st.maxRetryDelayMs), st.signal);
            current = await openUpstream(st, dec.offset());
        }
        for (const piece of dec.finish()) {
            yield piece;
        }
    }
    finally {
        current.body.destroy();
    }
}
export const downloadEncryptedStream = async (url, keys, opts = {}) => {
    const fetchOptions = opts.options || {};
    const { startByte, endByte } = opts;
    const ranged = !!(startByte || endByte);
    let startChunk = 0;
    let bytesFetched = 0;
    let firstBlockIsIV = false;
    if (startByte) {
        const chunk = floorToBlock(startByte);
        if (chunk) {
            startChunk = chunk - BLOCK_SIZE;
            bytesFetched = chunk;
            firstBlockIsIV = true;
        }
    }
    const endChunk = endByte ? floorToBlock(endByte) + BLOCK_SIZE : undefined;
    const baseHeaders = {
        ...normalizeHeaders(fetchOptions.headers),
        'Accept-Encoding': 'identity'
    };
    if (opts.origin) {
        baseHeaders.Origin = opts.origin;
        baseHeaders.Referer = `${opts.origin}/`;
    }
    const hosts = [...new Set((opts.hosts || []).filter(Boolean))];
    const verify = ranged || opts.verify === false ? 'none' : opts.verify === 'full' ? 'full' : 'mac';
    const st = {
        url: url.toString(),
        keys,
        hosts,
        hostIndex: 0,
        baseHeaders,
        startByte,
        endByte,
        startChunk,
        endChunk,
        bytesFetched,
        firstBlockIsIV,
        ranged,
        verify,
        encSha256: verify === 'full' ? toDigest(opts.encSha256) : undefined,
        fileSha256: verify === 'full' ? toDigest(opts.fileSha256) : undefined,
        expectedLength: toLength(opts.expectedLength),
        dispatcher: fetchOptions.dispatcher,
        agent: fetchOptions.agent,
        headerTimeoutMs: opts.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS,
        maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
        maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
        retryDelayMs: opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
        maxRetryDelayMs: opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
        failures: 0,
        signal: undefined
    };
    const controller = new AbortController();
    st.signal = controller.signal;
    const totalTimeoutMs = fetchOptions.timeoutMs || opts.timeoutMs || DEFAULT_TOTAL_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Boom('Media download timed out', { statusCode: 408 })), totalTimeoutMs);
    timer.unref?.();
    let first;
    try {
        first = await openUpstream(st, startChunk);
    }
    catch (err) {
        clearTimeout(timer);
        throw err;
    }
    const out = Readable.from(run(st, createDecryptor(st), first), {
        objectMode: false,
        highWaterMark: opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK
    });
    out.once('close', () => {
        clearTimeout(timer);
        controller.abort();
    });
    return out;
};
export const writeStreamToFile = async (stream, filePath) => {
    try {
        await pipeline(stream, createWriteStream(filePath, { highWaterMark: DEFAULT_HIGH_WATER_MARK }));
    }
    catch (err) {
        await fs.unlink(filePath).catch(() => { });
        throw err;
    }
    return filePath;
};
