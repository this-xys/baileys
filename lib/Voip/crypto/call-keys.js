import { TEXT_ENCODER, readUInt32LE, writeUInt32LE } from '../bytes.js';
import { hkdf, randomBytes } from './primitives.js';
export function derivePerJidSrtpKey(callKey, deviceJid) {
    const output = hkdf(callKey, null, TEXT_ENCODER.encode(deviceJid), 46);
    return {
        masterKey: output.subarray(0, 16),
        masterSalt: output.subarray(16, 30)
    };
}
export function generateCallKey() {
    return randomBytes(32);
}
export function generateSecureSsrc(callId, selfJid, counter = 0) {
    const key = TEXT_ENCODER.encode(callId);
    const salt = new Uint8Array(4);
    writeUInt32LE(salt, counter, 0);
    const info = TEXT_ENCODER.encode(selfJid);
    const result = hkdf(key, salt, info, 4);
    return readUInt32LE(result, 0);
}

export const WASM_RELAY_STREAM_SLOT_WORDS = [0, 1, 4, 2, 3, 5, 7, 8, 6];
export function deriveWasmRelayStreamSsrcs(callId, participantId) {
    return WASM_RELAY_STREAM_SLOT_WORDS.map((slotWord) => generateSecureSsrc(callId, participantId, slotWord));
}
