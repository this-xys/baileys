import { proto } from '../../WAProto/index.js';
import { createCache } from '../Addon/index.js';
import { ProtocolAddress, SessionBuilder, SessionCipher, SessionRecord } from '../LibSignal/index.js';
import { generateSignalPubKey } from '../Utils/index.js';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, jidEncode, WAJIDDomains } from '../WABinary/index.js';
import { SenderKeyName } from './Group/sender-key-name.js';
import { SenderKeyRecord } from './Group/sender-key-record.js';
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group/index.js';
import { LIDMappingStore } from './lid-mapping.js';
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
export function makeLibSignalRepository(auth, logger, pnToLIDFunc, getUSyncDevices) {
    const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc);
    const storage = signalStorage(auth, lidMapping, undefined, logger);
    const resolveLIDSignalAddress = (id) => resolveSignalAddressId(id, lidMapping);
    const pinResolutionForStorage = (rawAddr, wireJid) => signalStorage(auth, lidMapping, async (id) => {
        if (id === rawAddr)
            return wireJid;
        return resolveSignalAddressId(id, lidMapping);
    }, logger);
    const parsedKeys = auth.keys;
    const migratedSessionCache = createCache({
        max: 10000,
        ttl: 3 * 24 * 60 * 60
    });
    const usyncDevicesCache = createCache({ max: 2000, ttl: 10 * 60 });
    const ensureSenderKeyAndCreateSkdm = async (group, meId) => {
        const senderName = jidToSignalSenderKeyName(group, meId);
        const senderNameStr = senderName.toString();
        const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
        if (!senderKey) {
            await storage.storeSenderKey(senderName, new SenderKeyRecord());
        }
        const skdm = await new GroupSessionBuilder(storage).create(senderName);
        return { senderName, skdm };
    };
    const repository = {
        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            const cipher = new GroupCipher(storage, senderName);
            return parsedKeys.transaction(async () => {
                return cipher.decrypt(msg);
            }, group);
        },
        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const senderMsg = new SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            const senderNameStr = senderName.toString();
            return parsedKeys.transaction(async () => {
                const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
                if (!senderKey) {
                    await storage.storeSenderKey(senderName, new SenderKeyRecord());
                }
                await builder.process(senderName, senderMsg);
            }, item.groupId);
        },
        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid);
            const addrStr = addr.toString();
            const wireJid = await resolveLIDSignalAddress(addrStr);
            const pinnedStorage = pinResolutionForStorage(addrStr, wireJid);
            const session = new SessionCipher(pinnedStorage, addr);
            async function doDecrypt() {
                let result;
                switch (type) {
                    case 'pkmsg':
                        result = await session.decryptPreKeyWhisperMessage(ciphertext);
                        break;
                    case 'msg':
                        result = await session.decryptWhisperMessage(ciphertext);
                        break;
                }
                return result;
            }
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
                return await doDecrypt();
            }, jid);
        },
        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            const addrStr = addr.toString();
            const wireJid = await resolveLIDSignalAddress(addrStr);
            const pinnedStorage = pinResolutionForStorage(addrStr, wireJid);
            const cipher = new SessionCipher(pinnedStorage, addr);
            return parsedKeys.transaction(async () => {
                const { type: sigType, body } = await cipher.encrypt(data);
                const type = sigType === 3 ? 'pkmsg' : 'msg';
                return { type, ciphertext: Buffer.from(body, 'binary') };
            }, jid);
        },
        async encryptGroupMessage({ group, meId, data }) {
            const senderName = jidToSignalSenderKeyName(group, meId);
            return parsedKeys.transaction(async () => {
                const { skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                const ciphertext = await new GroupCipher(storage, senderName).encrypt(data);
                return { ciphertext, senderKeyDistributionMessage: skdm.serialize() };
            }, group);
        },
        async getSenderKeyDistributionMessage({ group, meId }) {
            return parsedKeys.transaction(async () => {
                const { skdm } = await ensureSenderKeyAndCreateSkdm(group, meId);
                return skdm.serialize();
            }, group);
        },
        async hasSenderKey({ group, meId }) {
            const senderName = jidToSignalSenderKeyName(group, meId).toString();
            const { [senderName]: key } = await auth.keys.get('sender-key', [senderName]);
            return !!key;
        },
        async getSessionInfo(jid) {
            const addr = jidToSignalProtocolAddress(jid).toString();
            const session = (await storage.loadSession(addr));
            if (!session) {
                return null;
            }
            const open = session.getOpenSession?.();
            const baseKey = open?.indexInfo?.baseKey;
            const registrationId = open?.registrationId;
            if (!baseKey || typeof registrationId !== 'number') {
                return null;
            }
            return { baseKey: new Uint8Array(baseKey), registrationId };
        },
        async injectE2ESession({ jid, session }) {
            logger?.trace({ jid }, 'injecting E2EE session');
            const addr = jidToSignalProtocolAddress(jid);
            const addrStr = addr.toString();
            const wireJid = await resolveLIDSignalAddress(addrStr);
            const pinnedStorage = pinResolutionForStorage(addrStr, wireJid);
            const cipher = new SessionBuilder(pinnedStorage, addr);
            return parsedKeys.transaction(async () => {
                await cipher.initOutgoing(session);
            }, jid);
        },
        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        },
        lidMapping,
        async validateSession(jid) {
            try {
                const addr = jidToSignalProtocolAddress(jid);
                const session = await storage.loadSession(addr.toString());
                if (!session) {
                    return { exists: false, reason: 'no session' };
                }
                if (!session.haveOpenSession()) {
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
                const addr = jidToSignalProtocolAddress(jid).toString();
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
                    return jidToSignalProtocolAddress(jid).toString();
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
                    const fromAddress = jidToSignalProtocolAddress(jid).toString();
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
                        fromAddr: jidToSignalProtocolAddress(jid),
                        toAddr: jidToSignalProtocolAddress(lidWithDevice)
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
                        const fromSession = SessionRecord.deserialize(pnSession);
                        if (fromSession.haveOpenSession()) {
                            sessionUpdates[lidAddrStr] = fromSession.serialize();
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
const jidToSignalProtocolAddress = (jid) => {
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
    return new ProtocolAddress(signalUser, finalDevice);
};
const jidToSignalSenderKeyName = (group, user) => {
    return new SenderKeyName(group, jidToSignalProtocolAddress(user));
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
