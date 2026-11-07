import { bridge, rust } from './bridge.js';

const guard = (fn) => {
    if (!rust.appstate)
        return null;
    try {
        return Buffer.from(fn());
    }
    catch {
        return null;
    }
};

export const rustContentMac = (opByte, data, keyId, key) => guard(() => bridge.generateContentMac(opByte, data, keyId, key));
export const rustSnapshotMac = (lthash, version, name, key) => guard(() => bridge.generateSnapshotMac(lthash, BigInt(version), name, key));
export const rustPatchMac = (snapshotMac, valueMacs, version, name, key) => guard(() => bridge.generatePatchMac(snapshotMac, valueMacs.map(m => (m instanceof Uint8Array ? m : new Uint8Array(m))), BigInt(version), name, key));
export const rustIndexMac = (indexBytes, key) => guard(() => bridge.generateIndexMac(indexBytes, key));
