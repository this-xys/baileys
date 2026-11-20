import { Boom } from '../Addon/index.js';
import { proto } from '../../WAProto/index.js';
import { WA_CERT_DETAILS } from '../Defaults/index.js';
import { Curve } from '../Utils/crypto.js';
import { bridge, guardErrors } from './bridge.js';
import { inflateSync } from 'node:zlib';
import * as constants from '../WABinary/constants.js';
import { decodeDecompressedBinaryNode } from '../WABinary/decode.js';
const EMPTY = Buffer.alloc(0);
const decodeNodeInJs = (plain) => {
    const buffer = Buffer.isBuffer(plain) ? plain : Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
    const body = buffer[0] & 2 ? inflateSync(buffer.subarray(1)) : buffer.subarray(1);
    return decodeDecompressedBinaryNode(body, constants);
};

export const makeRustNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {
    logger = logger.child({ class: 'ns' });
    const session = new bridge.NoiseSession(publicKey, NOISE_HEADER, routingInfo ? Uint8Array.from(routingInfo) : undefined);
    let handshakeFrameSeen = false;
    let pendingRaw = [];
    let lastServerEphemeral = null;
    const emit = (frame, onFrame) => {
        if (logger.level === 'trace') {
            logger.trace({ msg: frame?.attrs?.id }, 'recv frame');
        }
        onFrame(frame);
    };
    let lastOnFrame = null;
    let lastFilter = null;
    let lastOnDrop = null;
    let transportReady = false;
    let jsBuffer = EMPTY;
    const emitPlain = (plain, onFrame) => {
        let frame;
        try {
            const node = decodeNodeInJs(plain);
            frame = !lastFilter || lastFilter(node.tag, node.attrs?.id) ? node : undefined;
        }
        catch (err) {
            logger.error({ err: String(err?.message ?? err) }, 'failed to decode frame, dropping it');
            frame = undefined;
        }
        if (frame === undefined) {
            if (lastOnDrop)
                lastOnDrop();
            return;
        }
        emit(frame, onFrame);
    };
    const decodeFramesInJs = (newData, onFrame) => {
        const incoming = Buffer.isBuffer(newData) ? newData : Buffer.from(newData.buffer, newData.byteOffset, newData.byteLength);
        const data = jsBuffer.length ? Buffer.concat([jsBuffer, incoming]) : incoming;
        let offset = 0;
        try {
            while (data.length - offset >= 3) {
                const size = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
                if (data.length - offset - 3 < size) {
                    break;
                }
                const payload = data.subarray(offset + 3, offset + 3 + size);
                offset += 3 + size;
                if (!handshakeFrameSeen) {
                    handshakeFrameSeen = true;
                    emit(Buffer.from(payload), onFrame);
                }
                else if (!transportReady) {
                    pendingRaw.push(Uint8Array.from(payload));
                }
                else {
                    emitPlain(session.decrypt(payload), onFrame);
                }
            }
        }
        finally {
            jsBuffer = offset < data.length ? Buffer.from(data.subarray(offset)) : EMPTY;
        }
    };
    const flushPending = (onFrame) => {
        const queued = pendingRaw;
        pendingRaw = [];
        for (const raw of queued) {
            emitPlain(session.decrypt(raw), onFrame);
        }
    };
    const handler = {
        encrypt: (plaintext) => Buffer.from(session.encrypt(plaintext)),
        decrypt: (ciphertext) => Buffer.from(session.decrypt(ciphertext)),
        authenticate: (data) => session.authenticate(data),
        mixIntoKey: (data) => session.mixIntoKey(data),
        finishInit: async () => {
            session.finishInit();
            transportReady = true;
            logger.trace('Noise handler transitioned to Transport state');
            if (pendingRaw.length && lastOnFrame) {
                logger.trace({ frames: pendingRaw.length }, 'Flushing buffered frames after transport ready');
                flushPending(lastOnFrame);
            }
        },
        processHandshake: ({ serverHello }, noiseKey) => {
            lastServerEphemeral = serverHello.ephemeral;
            const certDecoded = session.processHandshakeInit(serverHello.ephemeral, serverHello.static, serverHello.payload, privateKey);
            const { intermediate: certIntermediate, leaf } = proto.CertChain.decode(certDecoded);
            if (!leaf?.details || !leaf?.signature) {
                throw new Boom('invalid noise leaf certificate', { statusCode: 400 });
            }
            if (!certIntermediate?.details || !certIntermediate?.signature) {
                throw new Boom('invalid noise intermediate certificate', { statusCode: 400 });
            }
            const details = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details);
            const { issuerSerial } = details;
            const verify = Curve.verify(details.key, leaf.details, leaf.signature);
            const verifyIntermediate = Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature);
            if (!verify) {
                throw new Boom('noise certificate signature invalid', { statusCode: 400 });
            }
            if (!verifyIntermediate) {
                throw new Boom('noise intermediate certificate signature invalid', { statusCode: 400 });
            }
            if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
                throw new Boom('certification match failed', { statusCode: 400 });
            }
            return Buffer.from(session.processHandshakeFinish(noiseKey.public, noiseKey.private, serverHello.ephemeral));
        },
        encodeFrame: (data) => Buffer.from(session.encodeFrameRaw(data)),
        decodeFrame: async (newData, onFrame, filter, onDrop) => {
            lastOnFrame = onFrame;
            lastFilter = filter || null;
            lastOnDrop = onDrop || null;
            decodeFramesInJs(newData, onFrame);
        }
    };
    return guardErrors(handler);
};
