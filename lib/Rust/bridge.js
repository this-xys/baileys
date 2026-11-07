import * as bridge from 'whatsapp-rust-bridge';

const env = typeof process !== 'undefined' && process.env ? process.env : {};
const OFF = new Set(['0', 'false', 'off', 'no']);
const ON = new Set(['1', 'true', 'on', 'yes']);

const readFlag = (name) => {
    const v = env[name];
    if (v === undefined)
        return undefined;
    const s = String(v).trim().toLowerCase();
    if (OFF.has(s))
        return false;
    if (ON.has(s))
        return true;
    return undefined;
};

const areaEnabled = (area) => {
    const own = readFlag(`BAILEYS_RUST_${area}`);
    if (own !== undefined)
        return own;
    const global = readFlag('BAILEYS_RUST');
    return global !== undefined ? global : true;
};

const has = (...names) => names.every(n => typeof bridge[n] !== 'undefined');

export const rust = {
    codec: areaEnabled('CODEC') && has('encodeNode', 'decodeNode'),
    noise: areaEnabled('NOISE') && has('NoiseSession', 'getWAConnHeader'),
    signal: areaEnabled('SIGNAL') && has('SessionCipher', 'SessionBuilder', 'SessionRecord', 'ProtocolAddress', 'GroupCipher', 'GroupSessionBuilder', 'SenderKeyName', 'SenderKeyRecord', 'SenderKeyDistributionMessage'),
    crypto: areaEnabled('CRYPTO') && has('generateKeyPair', 'calculateAgreement', 'calculateSignature', 'verifySignature'),
    appstate: areaEnabled('CRYPTO') && has('generateContentMac', 'generateSnapshotMac', 'generatePatchMac', 'generateIndexMac')
};

const readFeatures = () => {
    try {
        if (typeof bridge.getEnabledFeatures === 'function') {
            const f = bridge.getEnabledFeatures();
            return { audio: !!f?.audio, image: !!f?.image, sticker: !!f?.sticker };
        }
    }
    catch { }
    return { audio: false, image: false, sticker: false };
};

export const features = readFeatures();

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
let attachedSource = null;

const makeBridgeLogger = (source) => {
    const target = { };
    Object.defineProperty(target, 'level', {
        enumerable: true,
        get: () => String(source.level ?? 'info')
    });
    for (const name of LEVELS) {
        target[name] = (obj, msg) => {
            try {
                const fn = source[name];
                if (typeof fn === 'function')
                    fn.call(source, { class: 'rust', ...obj }, msg);
            }
            catch { }
        };
    }
    return target;
};

export const attachRustLogger = (logger) => {
    if (!logger || logger === attachedSource)
        return false;
    if (typeof bridge.setLogger !== 'function' || typeof bridge.updateLogger !== 'function')
        return false;
    try {
        const wrapped = makeBridgeLogger(logger);
        if (typeof bridge.hasLogger === 'function' && bridge.hasLogger())
            bridge.updateLogger(wrapped);
        else
            bridge.setLogger(wrapped);
        attachedSource = logger;
        return true;
    }
    catch {
        return false;
    }
};

export const logRust = (level, message) => {
    if (typeof bridge.logMessage !== 'function')
        return;
    try {
        bridge.logMessage(level, message);
    }
    catch { }
};

export const describeRust = () => ({ ...rust, features, logger: attachedSource !== null });

export const asError = (e) => {
    if (e instanceof Error)
        return e;
    const text = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : String(e);
    let err;
    if (/SessionNotFound|no session/i.test(text)) {
        err = new Error('No session record');
        err.name = 'SessionError';
    }
    else {
        err = new Error(text);
    }
    err.cause = e;
    return err;
};

export const guardErrors = (obj) => {
    for (const key of Object.keys(obj)) {
        const fn = obj[key];
        if (typeof fn !== 'function')
            continue;
        obj[key] = (...args) => {
            try {
                const out = fn.apply(obj, args);
                if (out && typeof out.then === 'function')
                    return out.catch((e) => {
                        throw asError(e);
                    });
                return out;
            }
            catch (e) {
                throw asError(e);
            }
        };
    }
    return obj;
};

export { bridge };
export default bridge;
