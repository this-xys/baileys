let cachedModule = null;

export async function resolveBaileysModule() {
    if (cachedModule)
        return cachedModule;
    const [jid, generic, signal, validate, tc, proto] = await Promise.all([
        import('../../WABinary/jid-utils.js'),
        import('../../WABinary/generic-utils.js'),
        import('../../Utils/signal.js'),
        import('../../Utils/validate-connection.js'),
        import('../../Utils/tc-token-utils.js'),
        import('../../../WAProto/index.js')
    ]);
    cachedModule = {
        jidDecode: jid.jidDecode,
        jidEncode: jid.jidEncode,
        getBinaryNodeChild: generic.getBinaryNodeChild,
        getAllBinaryNodeChildren: generic.getAllBinaryNodeChildren,
        parseAndInjectE2ESessions: signal.parseAndInjectE2ESessions,
        encodeSignedDeviceIdentity: validate.encodeSignedDeviceIdentity,
        resolveTcTokenJid: tc.resolveTcTokenJid,
        resolveIssuanceJid: tc.resolveIssuanceJid,
        isTcTokenExpired: tc.isTcTokenExpired,
        storeTcTokensFromIqResult: tc.storeTcTokensFromIqResult,
        buildMergedTcTokenIndexWrite: tc.buildMergedTcTokenIndexWrite,
        proto: proto.proto
    };
    return cachedModule;
}
export async function getProto() {
    return (await resolveBaileysModule()).proto;
}
