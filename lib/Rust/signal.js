import { bridge, guardErrors } from './bridge.js';

const PROTO_FIRST_BYTE = 0x0a;
const LEGACY_JSON_FIRST_BYTE = 0x5b;

const isBytes = (v) => v instanceof Uint8Array;

export const isLegacySessionObject = (v) => !!v && !isBytes(v) && typeof v === 'object' && ('_sessions' in v || ('registrationId' in v && 'currentRatchet' in v));

export const normalizeSenderKeyBytes = (stored, SenderKeyRecordJS) => {
    if (!stored)
        return undefined;
    const buf = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
    if (!buf.length)
        return undefined;
    if (buf[0] === PROTO_FIRST_BYTE || buf[0] === LEGACY_JSON_FIRST_BYTE)
        return buf;
    const record = SenderKeyRecordJS.deserialize(buf);
    if (record.isEmpty())
        return undefined;
    const structures = record.senderKeyStates.map(state => state.getStructure());
    return Buffer.from(JSON.stringify(structures));
};

const readVarint = (buf, pos) => {
    let result = 0;
    let shift = 0;
    for (;;) {
        const b = buf[pos++];
        result += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80))
            return [result, pos];
        shift += 7;
        if (shift > 63)
            throw new Error('varint too long');
    }
};
const parseFields = (buf) => {
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
        let tag;
        [tag, pos] = readVarint(buf, pos);
        const field = Math.floor(tag / 8);
        const wire = tag & 7;
        if (wire === 0) {
            let v;
            [v, pos] = readVarint(buf, pos);
            fields.push({ field, value: v });
        }
        else if (wire === 2) {
            let len;
            [len, pos] = readVarint(buf, pos);
            fields.push({ field, value: buf.subarray(pos, pos + len) });
            pos += len;
        }
        else if (wire === 1) {
            pos += 8;
        }
        else if (wire === 5) {
            pos += 4;
        }
        else {
            throw new Error(`unsupported wire type ${wire}`);
        }
    }
    return fields;
};
export const readSessionInfoFromProtobuf = (bytes) => {
    const record = parseFields(Buffer.from(bytes));
    const current = record.find(f => f.field === 1 && isBytes(f.value));
    if (!current)
        return null;
    const session = parseFields(current.value);
    const baseKey = session.find(f => f.field === 13 && isBytes(f.value))?.value;
    const registrationId = session.find(f => f.field === 10 && typeof f.value === 'number')?.value;
    if (!baseKey || typeof registrationId !== 'number')
        return null;
    return { baseKey: new Uint8Array(baseKey), registrationId };
};

export const makeRustSignalEngine = ({ auth, lidMapping, logger, resolveSignalAddressId, generateSignalPubKey, SenderKeyRecordJS, SessionRecordJS }) => {
    const { ProtocolAddress, SessionBuilder, SessionCipher, SessionRecord, GroupCipher, GroupSessionBuilder, SenderKeyName, SenderKeyDistributionMessage } = bridge;
    const { creds, keys } = auth;

    const makeStorage = (pinnedResolver) => {
        const resolve = pinnedResolver ?? (id => resolveSignalAddressId(id, lidMapping));
        const storeSessionBytes = async (id, bytes) => {
            const wireJid = await resolve(id);
            await keys.set({ session: { [wireJid]: Buffer.from(bytes) } });
        };
        return {
            loadSession: async (id) => {
                try {
                    const wireJid = await resolve(id);
                    const { [wireJid]: sess } = await keys.get('session', [wireJid]);
                    return sess ?? null;
                }
                catch {
                    return null;
                }
            },
            storeSession: (id, record) => storeSessionBytes(id, record.serialize()),
            storeSessionRaw: (id, data) => storeSessionBytes(id, data),
            isTrustedIdentity: () => true,
            loadIdentityKey: async (id) => {
                const wireJid = await resolve(id);
                const { [wireJid]: key } = await keys.get('identity-key', [wireJid]);
                return key || undefined;
            },
            saveIdentity: async (id, identityKey) => {
                const wireJid = await resolve(id);
                const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid]);
                const keysMatch = existingKey?.length === identityKey.length && existingKey.every((byte, i) => byte === identityKey[i]);
                if (existingKey && !keysMatch) {
                    await keys.set({
                        session: { [wireJid]: null },
                        'identity-key': { [wireJid]: identityKey }
                    });
                    return true;
                }
                if (!existingKey) {
                    await keys.set({ 'identity-key': { [wireJid]: identityKey } });
                    return true;
                }
                return false;
            },
            loadPreKey: async (id) => {
                const keyId = id.toString();
                const { [keyId]: key } = await keys.get('pre-key', [keyId]);
                if (key) {
                    return { privKey: Buffer.from(key.private), pubKey: Buffer.from(key.public) };
                }
                return undefined;
            },
            removePreKey: async (id) => {
                await keys.set({ 'pre-key': { [id]: null } });
            },
            loadSignedPreKey: () => {
                const key = creds.signedPreKey;
                return {
                    keyPair: {
                        privKey: Buffer.from(key.keyPair.private),
                        pubKey: Buffer.from(generateSignalPubKey(key.keyPair.public))
                    },
                    signature: key.signature ? Buffer.from(key.signature) : undefined
                };
            },
            loadSenderKey: async (keyId) => {
                const { [keyId]: stored } = await keys.get('sender-key', [keyId]);
                try {
                    return normalizeSenderKeyBytes(stored, SenderKeyRecordJS);
                }
                catch (err) {
                    logger?.warn({ err, keyId }, 'unreadable sender-key record, treating it as missing');
                    return undefined;
                }
            },
            storeSenderKey: async (keyId, record) => {
                await keys.set({ 'sender-key': { [keyId]: Buffer.from(record) } });
            },
            getOurRegistrationId: () => creds.registrationId,
            getOurIdentity: () => {
                const { signedIdentityKey } = creds;
                return {
                    privKey: Buffer.from(signedIdentityKey.private),
                    pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public))
                };
            }
        };
    };

    const storage = makeStorage();
    const senderKeyName = (group, address) => new SenderKeyName(group, address);

    const engine = {
        name: 'rust',
        makeAddress: (user, device) => new ProtocolAddress(user, device),
        makeStorage,
        async groupDecrypt({ group, address, msg }) {
            return Buffer.from(await new GroupCipher(storage, group, address).decrypt(msg));
        },
        async groupProcessSkdm({ group, address, skdm }) {
            const builder = new GroupSessionBuilder(storage);
            await builder.process(senderKeyName(group, address), SenderKeyDistributionMessage.deserialize(skdm));
        },
        async ensureSkdm({ group, address }) {
            const skdm = await new GroupSessionBuilder(storage).create(senderKeyName(group, address));
            return skdm.serialize();
        },
        async groupEncrypt({ group, address, data }) {
            const skdm = await this.ensureSkdm({ group, address });
            const ciphertext = await new GroupCipher(storage, group, address).encrypt(data);
            return { ciphertext: Buffer.from(ciphertext), senderKeyDistributionMessage: skdm };
        },
        async sessionDecrypt({ pinnedStorage, address, type, ciphertext }) {
            const cipher = new SessionCipher(pinnedStorage, address);
            const out = type === 'pkmsg'
                ? await cipher.decryptPreKeyWhisperMessage(ciphertext)
                : await cipher.decryptWhisperMessage(ciphertext);
            return Buffer.from(out);
        },
        async sessionEncrypt({ pinnedStorage, address, data }) {
            const { type: sigType, body } = await new SessionCipher(pinnedStorage, address).encrypt(data);
            return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body) };
        },
        async sessionInject({ pinnedStorage, address, bundle }) {
            await new SessionBuilder(pinnedStorage, address).initOutgoing(bundle);
        },
        async sessionInfo(addrStr) {
            const stored = await storage.loadSession(addrStr);
            if (!stored)
                return null;
            if (isLegacySessionObject(stored)) {
                const open = SessionRecordJS.deserialize(stored).getOpenSession?.();
                const baseKey = open?.indexInfo?.baseKey;
                const registrationId = open?.registrationId;
                if (!baseKey || typeof registrationId !== 'number')
                    return null;
                return { baseKey: new Uint8Array(baseKey), registrationId };
            }
            try {
                return readSessionInfoFromProtobuf(stored);
            }
            catch (err) {
                logger?.debug?.({ err, addrStr }, 'could not read session info');
                return null;
            }
        },
        isSessionOpen(stored) {
            if (!stored)
                return false;
            if (isLegacySessionObject(stored))
                return SessionRecordJS.deserialize(stored).haveOpenSession();
            return SessionRecord.deserialize(stored).haveOpenSession();
        },
        cloneSession: (stored) => stored
    };
    return guardErrors(engine);
};
