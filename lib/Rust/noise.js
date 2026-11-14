import { Boom } from '../Addon/index.js';
import { proto } from '../../WAProto/index.js';
import { WA_CERT_DETAILS } from '../Defaults/index.js';
import { Curve } from '../Utils/crypto.js';
import { bridge, guardErrors } from './bridge.js';
import { materializeNode, releaseNode } from './codec.js';

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
    const emitNode = (item, onFrame) => {
        if (lastFilter) {
            const attrs = item.attrs;
            if (!lastFilter(item.tag, attrs ? attrs.id : undefined)) {
                releaseNode(item);
                if (lastOnDrop)
                    lastOnDrop();
                return;
            }
        }
        emit(materializeNode(item), onFrame);
    };
    const flushPending = (onFrame) => {
        const queued = pendingRaw;
        pendingRaw = [];
        for (const raw of queued) {
            const plain = session.decrypt(raw);
            emitNode(bridge.decodeNode(plain), onFrame);
        }
    };
    const handler = {
        encrypt: (plaintext) => Buffer.from(session.encrypt(plaintext)),
        decrypt: (ciphertext) => Buffer.from(session.decrypt(ciphertext)),
        authenticate: (data) => session.authenticate(data),
        mixIntoKey: (data) => session.mixIntoKey(data),
        finishInit: async () => {
            session.finishInit();
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
            const items = session.decodeFrame(newData);
            for (const item of items) {
                if (item instanceof Uint8Array) {
                    if (handshakeFrameSeen) {
                        pendingRaw.push(item);
                        continue;
                    }
                    handshakeFrameSeen = true;
                    emit(Buffer.from(item), onFrame);
                    continue;
                }
                emitNode(item, onFrame);
            }
        }
    };
    return guardErrors(handler);
};
