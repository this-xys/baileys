'use strict';

 *   const { makeWASocket, useMultiFileAuthState, Browsers } = require('@blckrose/baileys');
 *
 *   async function start() {
 *     const { state, saveCreds } = await useMultiFileAuthState('./auth');
 *     const conn = makeWASocket({ auth: state });
 *   }
 *   start();

let _mod = null;
let _loadPromise = null;
let _loadError = null;

function _load() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = import('./lib/index.js').then(mod => {
    _mod = mod;
    for (const key of Object.keys(mod)) {
      if (key === 'default') continue;
      const val = mod[key];
      if (typeof val === 'function') continue;
      Object.defineProperty(module.exports, key, {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    Object.defineProperty(module.exports, 'default', {
      value: mod.default,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    module.exports.ready = Promise.resolve(mod);
    return mod;
  }).catch(err => {
    _loadError = err;
    throw err;
  });
  return _loadPromise;
}

_load();

module.exports.ready = _loadPromise;
module.exports.load = _load;

function _wrapFn(name) {
  return async function(...args) {
    if (_loadError) throw new Error('[blckrose-baileys] Load failed: ' + _loadError.message);
    if (!_mod) await _load();
    const fn = name === 'makeWASocket' ? _mod.default : _mod[name];
    if (typeof fn !== 'function') throw new Error('[blckrose-baileys] "' + name + '" bukan fungsi');
    return fn(...args);
  };
}

function _wrapMakeWASocket() {
  return function makeWASocket(...args) {
    if (_mod) return _mod.default(...args);
    if (_loadError) throw new Error('[blckrose-baileys] Load failed: ' + _loadError.message);
    throw new Error(
      '[blckrose-baileys] makeWASocket dipanggil sebelum Baileys selesai load.\n' +
      'Pastikan await useMultiFileAuthState() dulu (itu sudah cukup untuk menunggu load).'
    );
  };
}

function _makeLazyGetter(name) {
  return function() {
    if (_loadError) throw new Error('[blckrose-baileys] Load failed: ' + _loadError.message);
    if (_mod) return _mod[name];
    throw new Error(
      '[blckrose-baileys] "' + name + '" belum siap. ' +
      'Gunakan await useMultiFileAuthState() sebelum akses konstanta ini.'
    );
  };
}

const _functions = [
  'addTransactionCapability','aesDecrypt','aesDecryptCTR','aesDecryptGCM',
  'aesDecryptWithIV','aesEncrypWithIV','aesEncrypt','aesEncryptCTR','aesEncryptGCM',
  'aggregateMessageKeysNotFromMe','areJidsSameUser','assertMediaContent',
  'assertNodeErrorFree','bindWaitForConnectionUpdate','bindWaitForEvent',
  'bytesToCrockford','chatModificationToAppPatch','debouncedTimeout',
  'decodeMediaRetryNode','decodePatches','decodeSyncdMutations','decodeSyncdPatch',
  'decodeSyncdSnapshot','decryptMediaRetryData','delay','delayCancellable',
  'derivePairingCodeKey','downloadContentFromMessage','downloadEncryptedContent',
  'downloadExternalBlob','downloadExternalPatch','downloadMediaMessage',
  'encodeBase64EncodedStringForUpload','encodeBigEndian','encodeNewsletterMessage',
  'encodeSyncdPatch','encodeWAMessage','encryptMediaRetryRequest','encryptedStream',
  'extensionForMediaMessage','extractImageThumb','extractMessageContent',
  'extractSyncdPatches','extractUrlFromText','fetchLatestBaileysVersion',
  'fetchLatestWaWebVersion','generateForwardMessageContent',
  'generateLinkPreviewIfRequired','generateMdTagPrefix','generateMessageID',
  'generateMessageIDV2','generateParticipantHashV2','generateProfilePicture',
  'generateRegistrationId','generateSignalPubKey','generateThumbnail',
  'generateWAMessage','generateWAMessageContent','generateWAMessageFromContent',
  'getAggregateResponsesInEventMessage','getAggregateVotesInPollMessage',
  'getAllBinaryNodeChildren','getAudioDuration','getAudioWaveform',
  'getBinaryNodeChild','getBinaryNodeChildBuffer','getBinaryNodeChildString',
  'getBinaryNodeChildUInt','getBinaryNodeChildren','getBinaryNodeMessages',
  'getCallStatusFromNode','getCodeFromWSError','getContentType','getDevice',
  'getErrorCodeFromStreamError','getHttpStream','getKeyAuthor','getMediaKeys',
  'getMediaTypeFromContentType','getPlatformId','getRawMediaUploadData',
  'getServerFromDomainType','getStatusCodeForMediaRetry','getStatusFromReceiptType',
  'getStream','getUrlFromDirectPath','getWAUploadToServer','hasNonNullishProperty',
  'hkdf','hkdfInfoKey','hmacSign','initAuthCreds','isHostedLidUser','isHostedPnUser',
  'isJidBot','isJidBroadcast','isJidGroup','isJidMetaAI','isJidNewsletter',
  'isJidStatusBroadcast','isLidUser','isPnUser','isStringNullOrEmpty',
  'isWABusinessPlatform','jidDecode','jidEncode','jidNormalizedUser',
  'makeCacheableSignalKeyStore','md5','mediaMessageSHA256B64','newLTHashState',
  'normalizeMessageContent','prepareDisappearingMessageSettingContent',
  'prepareWAMessageMedia','processSyncAction','promiseTimeout',
  'reduceBinaryNodeToDictionary','sha256','signedKeyPair','toBuffer','toNumber',
  'toReadable','transferDevice','trimUndefined','unixTimestampSeconds',
  'unpadRandomMax16','updateMessageWithEventResponse','updateMessageWithPollUpdate',
  'updateMessageWithReaction','updateMessageWithReceipt','uploadWithNodeHttp',
  'useMultiFileAuthState','writeRandomPadMax16','makeNewsletterUtils','resolveJid','resolveJids','createApocalypse','binaryNodeToString',
];

const _constants = [
  'Browsers','apocalypse','BufferJSON','CALL_AUDIO_PREFIX','CALL_VIDEO_PREFIX','Curve',
  'DEFAULT_CACHE_TTLS','DEFAULT_CONNECTION_CONFIG','DEFAULT_ORIGIN',
  'DEF_CALLBACK_PREFIX','DEF_TAG_PREFIX','DICT_VERSION','DisconnectReason',
  'INITIAL_PREKEY_COUNT','KEY_BUNDLE_TYPE','MEDIA_HKDF_KEY_MAPPING','MEDIA_KEYS',
  'MEDIA_PATH_MAP','META_AI_JID','MIN_PREKEY_COUNT','MIN_UPLOAD_INTERVAL',
  'NOISE_MODE','NOISE_WA_HEADER','OFFICIAL_BIZ_JID','PHONE_CONNECTION_CB',
  'PLACEHOLDER_MAX_AGE_SECONDS','PROCESSABLE_HISTORY_TYPES','PSA_WID','proto',
  'SERVER_JID','STATUS_EXPIRY_SECONDS','STORIES_JID','S_WHATSAPP_NET','TimeMs',
  'UNAUTHORIZED_CODES','UPLOAD_TIMEOUT','URL_REGEX','WA_ADV_ACCOUNT_SIG_PREFIX',
  'WA_ADV_DEVICE_SIG_PREFIX','WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX',
  'WA_ADV_HOSTED_DEVICE_SIG_PREFIX','WA_CERT_DETAILS','WA_DEFAULT_EPHEMERAL',
  'WAJIDDomains',
];

for (const name of _functions) {
  Object.defineProperty(module.exports, name, {
    value: _wrapFn(name),
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

Object.defineProperty(module.exports, 'makeWASocket', {
  value: _wrapMakeWASocket(),
  writable: true,
  enumerable: true,
  configurable: true,
});

for (const name of _constants) {
  if (name in module.exports) continue;
  Object.defineProperty(module.exports, name, {
    get: _makeLazyGetter(name),
    set(v) {
      Object.defineProperty(module.exports, name, {
        value: v, writable: true, enumerable: true, configurable: true,
      });
    },
    enumerable: true,
    configurable: true,
  });
}