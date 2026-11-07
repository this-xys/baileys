import { proto } from '../../WAProto/index.js';
import { createCache } from '../Addon/index.js';
import { ProtocolAddress, SessionBuilder, SessionCipher, SessionRecord } from '../LibSignal/index.js';
import { generateSignalPubKey } from '../Utils/index.js';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, jidEncode, WAJIDDomains } from '../WABinary/index.js';
import { SenderKeyName } from './Group/sender-key-name.js';
import { SenderKeyRecord } from './Group/sender-key-record.js';
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group/index.js';
import { LIDMappingStore } from './lid-mapping.js';
import { attachRustLogger, rust } from '../Rust/bridge.js';
import { makeRustSignalEngine } from '../Rust/signal.js';
async function resolveSignalAddressId(id, lidMapping) {
    if (!id.includes('.'))
        return id;
    const [deviceId, device] = id.split('.');
    const [user, domainType_] = deviceId.split('_');
    const domainType = parseInt(domainType_ || '0');
    if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID)
        return id;
    const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`;
    const lidForPN = await lidMapping.getLIDForPN(pnJid);
    if (lidForPN) {
        const lidAddr = jidToSignalProtocolAddress(lidForPN);
        return lidAddr.toString();
    }
    return id;
}
function extractIdentityFromPkmsg(ciphertext) {
    try {
        if (!ciphertext || ciphertext.length < 2) {
            return undefined;
        }
        const version = ciphertext[0];
        if ((version & 0xf) !== 3) {
            return undefined;
        }
        const preKeyProto = proto.PreKeySignalMessage.decode(ciphertext.slice(1));
        if (preKeyProto.identityKey?.length === 33) {
            return new Uint8Array(preKeyProto.identityKey);
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}

const makeJsSignalEngine = ({ auth, lidMapping, logger }) => {
    const storage = signalStorage(auth, lidMapping, undefined, logger);
    const senderName = (group, address) => new SenderKeyName(group, address);
    return {
        name: 'js',
        makeAddress: (user, device) => new ProtocolAddress(user, device),
        makeStorage: (pinnedResolver) => signalStorage(auth, lidMapping, pinnedResolver, logger),
        async groupDecrypt({ group, address, msg }) {
            return new GroupCipher(storage, senderName(group, address)).decrypt(msg);
        },
        async groupProcessSkdm({ group, address, skdm }) {
            const name = senderName(group, address);
            const nameStr = name.toString();
            const { [nameStr]: senderKey } = await auth.keys.get('sender-key', [nameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(name, new SenderKeyRecord());
            }
            const msg = new SenderKeyDistributionMessage(null, null, null, null, skdm);
            await new GroupSessionBuilder(storage).process(name, msg);
        },
        async ensureSkdm({ group, address }) {
            const name = senderName(group, address);
            const nameStr = name.toString();
            const { [nameStr]: senderKey } = await auth.keys.get('sender-key', [nameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(name, new SenderKeyRecord());
            }
            const skdm = await new GroupSessionBuilder(storage).create(name);
            return skdm.serialize();
        },
        async groupEncrypt({ group, address, data }) {
            const skdm = await this.ensureSkdm({ group, address });
            const ciphertext = await new GroupCipher(storage, senderName(group, address)).encrypt(data);
            return { ciphertext, senderKeyDistributionMessage: skdm };
        },
        async sessionDecrypt({ pinnedStorage, address, type, ciphertext }) {
            const session = new SessionCipher(pinnedStorage, address);
            switch (type) {
                case 'pkmsg':
                    return session.decryptPreKeyWhisperMessage(ciphertext);
                case 'msg':
                    return session.decryptWhisperMessage(ciphertext);
            }
        },
        async sessionEncrypt({ pinnedStorage, address, data }) {
            const { type: sigType, body } = await new SessionCipher(pinnedStorage, address).encrypt(data);
            return { type: sigType === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body, 'binary') };
        },
        async sessionInject({ pinnedStorage, address, bundle }) {
            await new SessionBuilder(pinnedStorage, address).initOutgoing(bundle);
        },
        async sessionInfo(addrStr) {
            const session = await storage.loadSession(addrStr);
            if (!session)
                return null;
            const open = session.getOpenSession?.();
            const baseKey = open?.indexInfo?.baseKey;
            const registrationId = open?.registrationId;
            if (!baseKey || typeof registrationId !== 'number')
                return null;
            return { baseKey: new Uint8Array(baseKey), registrationId };
        },
        isSessionOpen(stored) {
            return !!stored && SessionRecord.deserialize(stored).haveOpenSession();
        },
        cloneSession: (stored) => SessionRecord.deserialize(stored).serialize()
    };
};
const makeSignalEngine = (deps, forced) => {
    if (forced === 'js')
        return makeJsSignalEngine(deps);
    if (rust.signal || forced === 'rust') {
        try {
            return makeRustSignalEngine({
                ...deps,
                resolveSignalAddressId,
                generateSignalPubKey,
                SenderKeyRecordJS: SenderKeyRecord,
                SessionRecordJS: SessionRecord
            });
        }
        catch (error) {
            deps.logger?.warn?.({ error }, 'rust signal engine unavailable, falling back to JS libsignal');
        }
    }
    return makeJsSignalEngine(deps);
};
export function makeLibSignalRepository(auth, logger, pnToLIDFunc, getUSyncDevices, options) {
    attachRustLogger(logger);
    const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc);
    const engine = makeSignalEngine({ auth, lidMapping, logger }, options?.engine);
    logger?.debug?.({ engine: engine.name }, 'signal engine selected');
    const resolveLIDSignalAddress = (id) => resolveSignalAddressId(id, lidMapping);
    const pinResolutionForStorage = (rawAddr, wireJid) => engine.makeStorage(async (id) => {
        if (id === rawAddr)
            return wireJid;
        return resolveSignalAddressId(id, lidMapping);
    });
    const toAddress = (jid) => jidToSignalAddress(jid, engine);
    const parsedKeys = auth.keys;
    const migratedSessionCache = createCache({
        max: 10000,
        ttl: 3 * 24 * 60 * 60
    });
    const usyncDevicesCache = createCache({ max: 2000, ttl: 10 * 60 });
    const repository = {
        decryptGroupMessage({ group, authorJid, msg }) {
            const address = toAddress(authorJid);
            return parsedKeys.transaction(async () => {
                return engine.groupDecrypt({ group, address, msg });
            }, group);
        },
        async processSenderKeyDistributionMessage({ item, authorJid }) {
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const address = toAddress(authorJid);
            return parsedKeys.transaction(async () => {
                await engine.groupProcessSkdm({ group: item.groupId, address, skdm: item.axolotlSenderKeyDistributionMessage });
            }, item.groupId);
        },
        async decryptMessage({ jid, type, ciphertext }) {
            const addr = toAddress(jid);
            const addrStr = addr.toString();
            const wireJid = await resolveLIDSignalAddress(addrStr);
            const pinnedStorage = pinResolutionForStorage(addrStr, wireJid);
            return parsedKeys.transaction(async () => {
                if (type === 'pkmsg') {
                    const identityKey = extractIdentityFromPkmsg(ciphertext);
                    if (identityKey) {
                        const identityChanged = await pinnedStorage.saveIdentity(addrStr, identityKey);
                        if (identityChanged) {
                            logger?.info({ jid, addr: addrStr }, 'identity key changed or new contact, session will be re-established');
                        }
                    }
                }
                return await engine.sessionDecrypt({ pinnedStorage, address: addr, type, ciphertext });
            }, jid);
        },
        async encryptMessage({ jid, data }) {
            const addr = toAddress(jid);
            const addrStr = addr.toString();
            const wireJid = await resolveLIDSignalAddress(addrStr);
            const pinnedStorage = pinResolutionForStorage(addrStr, wireJid);
            return parsedKeys.transaction(async () => {
                return engine.sessionEncrypt({ pinnedStorage, address: addr, data });
            }, jid);
        },
        async encryptGroupMessage({ group, meId, data }) {
            const address = toAddress(meId);
            return parsedKeys.transaction(async () => {
                return engine.groupEncrypt({ group, address, data });
            }, group);
        },
        async getSenderKeyDistributionMessage({ group, meId }) {
            const address = toAddress(meId);
            return parsedKeys.transaction(async () => {
                return engine.ensureSkdm({ group, address });
            }, group);
        },
        async hasSenderKey({ group, meId }) {
            const address = toAddress(meId);
            const senderName = `${group}::${address.id}::${address.deviceId}`;
            const { [senderName]: key } = await auth.keys.get('sender-key', [senderName]);
            return !!key;
        },
        async getSessionInfo(jid) {
            const addr = toAddress(jid).toString();
            return engine.sessionInfo(addr);
        },
        async injectE2ESession({ jid, session }) {
            logger?.trace({ jid }, 'injecting E2EE session');
            const addr = toAddress(jid);
            const addrStr = addr.toString();
            const wireJid = await resolveLIDSignalAddress(addrStr);
            const pinnedStorage = pinResolutionForStorage(addrStr, wireJid);
            return parsedKeys.transaction(async () => {
                await engine.sessionInject({ pinnedStorage, address: addr, bundle: session });
            }, jid);
        },
        jidToSignalProtocolAddress(jid) {
            return toAddress(jid).toString();
        },
        lidMapping,
        async validateSession(jid) {
            try {
                const addrStr = toAddress(jid).toString();
                const wireJid = await resolveLIDSignalAddress(addrStr);
                const { [wireJid]: stored } = await parsedKeys.get('session', [wireJid]);
                if (!stored) {
                    return { exists: false, reason: 'no session' };
                }
                if (!engine.isSessionOpen(stored)) {
                    return { exists: false, reason: 'no open session' };
                }
                return { exists: true };
            }
            catch (error) {
                return { exists: false, reason: 'validation error' };
            }
        },
        async deleteSession(jids) {
            if (!jids.length)
                return;
            const sessionUpdates = {};
            for (const jid of jids) {
                const addr = toAddress(jid).toString();
                const wireJid = await resolveLIDSignalAddress(addr);
                sessionUpdates[wireJid] = null;
            }
            return parsedKeys.transaction(async () => {
                await auth.keys.set({ session: sessionUpdates });
            }, `delete-${jids.length}-sessions`);
        },
        close() {
            migratedSessionCache.flushAll();
            usyncDevicesCache.flushAll();
            lidMapping.close();
        },
        async migrateSession(fromJid, toJid) {
            if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid)))
                return { migrated: 0, skipped: 0, total: 0 };
            if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) {
                return { migrated: 0, skipped: 0, total: 1 };
            }
            const { user } = jidDecode(fromJid);
            const sameUserPn = (jid) => {
                const decoded = jidDecode(jid);
                return !!decoded && decoded.user === user && (isPnUser(jid) || isHostedPnUser(jid));
            };
            const isMigrated = (jid) => {
                const decoded = jidDecode(jid);
                return !!decoded && migratedSessionCache.has(`${decoded.user}.${decoded.device || 0}`);
            };
            const { [user]: cachedDevices = [] } = await parsedKeys.get('device-list', [user]);
            const cachedDeviceJids = cachedDevices.map(device => {
                if (device === '99')
                    return `${user}:99@hosted`;
                return device === '0' ? `${user}@s.whatsapp.net` : `${user}:${device}@s.whatsapp.net`;
            });
            const localCandidates = [...new Set([fromJid, ...cachedDeviceJids])].filter(jid => sameUserPn(jid) && !isMigrated(jid));
            if (!localCandidates.length)
                return { migrated: 0, skipped: 0, total: 0 };
            const addressOf = (jid) => {
                try {
                    return toAddress(jid).toString();
                }
                catch (err) {
                    logger?.warn({ err, jid }, 'skipping device with invalid JID during session migration');
                    return null;
                }
            };
            const localSessions = await parsedKeys.get('session', localCandidates.map(addressOf).filter(Boolean));
            if (!Object.keys(localSessions).length) {
                return { migrated: 0, skipped: localCandidates.length, total: localCandidates.length };
            }
            let syncedDevices = usyncDevicesCache.get(user);
            if (!syncedDevices) {
                syncedDevices = [];
                if (getUSyncDevices) {
                    try {
                        syncedDevices = await getUSyncDevices(fromJid);
                        usyncDevicesCache.set(user, syncedDevices);
                    }
                    catch (err) {
                        logger?.warn({ err, fromJid }, 'USync device lookup failed, using cached device list for session migration');
                    }
                }
            }
            const deviceJids = [...new Set([...localCandidates, ...syncedDevices])].filter(jid => sameUserPn(jid) && !isMigrated(jid));
            logger?.debug({
                fromJid,
                totalDevices: deviceJids.length,
                devicesWithSessions: deviceJids.length,
                devices: deviceJids
            }, 'bulk device migration complete - all user devices processed');
            const lidUser = jidDecode(toJid).user;
            const migrationOps = [];
            const seenAddresses = new Set();
            for (const jid of deviceJids) {
                try {
                    const fromDecoded = jidDecode(jid);
                    const fromAddress = toAddress(jid).toString();
                    if (seenAddresses.has(fromAddress))
                        continue;
                    seenAddresses.add(fromAddress);
                    const lidWithDevice = jidEncode(lidUser, isHostedPnUser(jid) ? 'hosted.lid' : 'lid', fromDecoded.device || 0);
                    const toDecoded = jidDecode(lidWithDevice);
                    migrationOps.push({
                        fromJid: jid,
                        toJid: lidWithDevice,
                        pnUser: fromDecoded.user,
                        lidUser: toDecoded.user,
                        deviceId: fromDecoded.device || 0,
                        fromAddr: toAddress(jid),
                        toAddr: toAddress(lidWithDevice)
                    });
                }
                catch (err) {
                    logger?.warn({ err, jid }, 'skipping device that cannot be migrated');
                }
            }
            if (!migrationOps.length)
                return { migrated: 0, skipped: deviceJids.length, total: deviceJids.length };
            return parsedKeys.transaction(async () => {
                const totalOps = migrationOps.length;
                let migratedCount = 0;
                const pnAddrStrings = Array.from(new Set(migrationOps.map(op => op.fromAddr.toString())));
                const pnSessions = await parsedKeys.get('session', pnAddrStrings);
                const sessionUpdates = {};
                for (const op of migrationOps) {
                    const pnAddrStr = op.fromAddr.toString();
                    const lidAddrStr = op.toAddr.toString();
                    const pnSession = pnSessions[pnAddrStr];
                    if (pnSession) {
                        if (engine.isSessionOpen(pnSession)) {
                            sessionUpdates[lidAddrStr] = engine.cloneSession(pnSession);
                            sessionUpdates[pnAddrStr] = null;
                            migratedCount++;
                        }
                    }
                }
                if (migratedCount > 0) {
                    await parsedKeys.set({ session: sessionUpdates });
                    logger?.debug({ migratedSessions: migratedCount }, 'bulk session migration complete');
                    for (const op of migrationOps) {
                        if (sessionUpdates[op.toAddr.toString()]) {
                            const deviceKey = `${op.pnUser}.${op.deviceId}`;
                            migratedSessionCache.set(deviceKey, true);
                        }
                    }
                }
                const skippedCount = totalOps - migratedCount;
                return { migrated: migratedCount, skipped: skippedCount, total: totalOps };
            }, `migrate-${deviceJids.length}-sessions-${jidDecode(toJid)?.user}`);
        }
    };
    return repository;
}
const jidToSignalProtocolAddress = (jid) => jidToSignalAddress(jid, { makeAddress: (user, device) => new ProtocolAddress(user, device) });
const jidToSignalAddress = (jid, engine) => {
    const decoded = jidDecode(jid);
    const { user, device, server, domainType } = decoded;
    if (!user) {
        throw new Error(`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`);
    }
    const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
    const finalDevice = device || 0;
    if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
        throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid);
    }
    return engine.makeAddress(signalUser, finalDevice);
};
function signalStorage({ creds, keys }, lidMapping, pinnedResolver, logger) {
    const resolveLIDSignalAddress = pinnedResolver ?? (id => resolveSignalAddressId(id, lidMapping));
    return {
        loadSession: async (id) => {
            try {
                const wireJid = await resolveLIDSignalAddress(id);
                const { [wireJid]: sess } = await keys.get('session', [wireJid]);
                if (sess) {
                    return SessionRecord.deserialize(sess);
                }
            }
            catch (e) {
                return null;
            }
            return null;
        },
        storeSession: async (id, session) => {
            const wireJid = await resolveLIDSignalAddress(id);
            await keys.set({ session: { [wireJid]: session.serialize() } });
        },
        isTrustedIdentity: () => {
            return true;
        },
        loadIdentityKey: async (id) => {
            const wireJid = await resolveLIDSignalAddress(id);
            const { [wireJid]: key } = await keys.get('identity-key', [wireJid]);
            return key || undefined;
        },
        saveIdentity: async (id, identityKey) => {
            const wireJid = await resolveLIDSignalAddress(id);
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
                return {
                    privKey: Buffer.from(key.private),
                    pubKey: Buffer.from(key.public)
                };
            }
        },
        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),
        loadSignedPreKey: () => {
            const key = creds.signedPreKey;
            return {
                privKey: Buffer.from(key.keyPair.private),
                pubKey: Buffer.from(key.keyPair.public)
            };
        },
        loadSenderKey: async (senderKeyName) => {
            const keyId = senderKeyName.toString();
            const { [keyId]: key } = await keys.get('sender-key', [keyId]);
            if (key) {
                try {
                    return SenderKeyRecord.deserialize(key);
                }
                catch (err) {
                    logger?.warn({ err, keyId }, 'unreadable sender-key record, treating it as missing');
                    return new SenderKeyRecord();
                }
            }
            return new SenderKeyRecord();
        },
        storeSenderKey: async (senderKeyName, key) => {
            const keyId = senderKeyName.toString();
            await keys.set({ 'sender-key': { [keyId]: key.serialize() } });
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
}
