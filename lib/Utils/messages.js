import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import {} from 'stream';
import { proto } from '../../WAProto/index.js';
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { WAMessageStatus, WAProto } from '../Types/index.js';
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { sha256 } from './crypto.js';
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js';
import { downloadContentFromMessage, encryptedStream, prepareStream, generateThumbnail, getAudioDuration, getAudioWaveform, getStream, toBuffer } from './messages-media.js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
import { shouldIncludeReportingToken } from './reporting-utils.js';

const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg'
};
const AUDIO_MIMETYPE_MAP = {
    ogg: 'audio/ogg; codecs=opus',
    oga: 'audio/ogg; codecs=opus',
    opus: 'audio/ogg; codecs=opus',
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    mp4: 'audio/mp4',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    wave: 'audio/wav',
    flac: 'audio/flac',
    webm: 'audio/webm',
    amr: 'audio/amr',
    '3gp': 'audio/3gpp',
    '3gpp': 'audio/3gpp',
    wma: 'audio/x-ms-wma',
    caf: 'audio/x-caf',
    aiff: 'audio/aiff',
    aif: 'audio/aiff',
};
const detectAudioMimetypeFromBuffer = (buf) => {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53)
        return 'audio/ogg; codecs=opus';
    if ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
        (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0))
        return 'audio/mpeg';
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70)
        return 'audio/mp4';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45)
        return 'audio/wav';
    if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43)
        return 'audio/flac';
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3)
        return 'audio/webm';
    if (buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x41 && buf[3] === 0x4D &&
        buf[4] === 0x52)
        return 'audio/amr';
    return null;
};

const detectAudioMimetype = async (media) => {
    if (typeof media === 'string' || (media && typeof media === 'object' && 'url' in media)) {
        const urlStr = typeof media === 'string' ? media : media.url?.toString?.() ?? '';
        const pathOnly = urlStr.split('?')[0];
        const extMatch = pathOnly.match(/\.([a-zA-Z0-9]{2,5})(?:[^/]*)?$/);
        if (extMatch) {
            const ext = extMatch[1].toLowerCase();
            if (AUDIO_MIMETYPE_MAP[ext]) return AUDIO_MIMETYPE_MAP[ext];
        }
        const segments = pathOnly.split('.');
        for (let i = segments.length - 1; i >= 0; i--) {
            const seg = segments[i].toLowerCase().split('/')[0].split('?')[0];
            if (AUDIO_MIMETYPE_MAP[seg]) return AUDIO_MIMETYPE_MAP[seg];
        }
    }
    if (Buffer.isBuffer(media)) {
        const detected = detectAudioMimetypeFromBuffer(media);
        if (detected) return detected;
    }
    return MIMETYPE_MAP.audio;
};
const MessageTypeProto = {
    image: WAProto.Message.ImageMessage,
    video: WAProto.Message.VideoMessage,
    audio: WAProto.Message.AudioMessage,
    sticker: WAProto.Message.StickerMessage,
    document: WAProto.Message.DocumentMessage
};
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];
export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text);
    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url);
            return urlInfo;
        }
        catch (error) {
            logger?.warn({ trace: error.stack }, 'url generation failed');
        }
    }
};
const assertColor = async (color) => {
    let assertedColor;
    if (typeof color === 'number') {
        assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1;
    }
    else {
        let hex = color.trim().replace('#', '');
        if (hex.length <= 6) {
            hex = 'FF' + hex.padStart(6, '0');
        }
        assertedColor = parseInt(hex, 16);
        return assertedColor;
    }
};
export const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger;
    let mediaType;
    for (const key of MEDIA_KEYS) {
        if (key in message) {
            mediaType = key;
        }
    }
    if (!mediaType) {
        throw new Boom('Invalid media type', { statusCode: 400 });
    }
    const uploadData = {
        ...message,
        media: message[mediaType]
    };
    delete uploadData[mediaType];
    const cacheableKey = typeof uploadData.media === 'object' &&
        'url' in uploadData.media &&
        !!uploadData.media.url &&
        !!options.mediaCache &&
        mediaType + ':' + uploadData.media.url.toString();
    if (mediaType === 'document' && !uploadData.fileName) {
        uploadData.fileName = 'file';
    }
    if (!uploadData.mimetype) {
        if (mediaType === 'audio') {
            uploadData.mimetype = await detectAudioMimetype(uploadData.media);
        } else {
            uploadData.mimetype = MIMETYPE_MAP[mediaType];
        }
    }
    if (mediaType === 'audio' && !uploadData.ptt) {
        uploadData.mimetype = 'audio/mpeg';
    }
    if (cacheableKey) {
        const mediaBuff = await options.mediaCache.get(cacheableKey);
        if (mediaBuff) {
            logger?.debug({ cacheableKey }, 'got media cache hit');
            const obj = proto.Message.decode(mediaBuff);
            const key = `${mediaType}Message`;
            Object.assign(obj[key], { ...uploadData, media: undefined });
            return obj;
        }
    }
    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
    if (isNewsletter) options.newsletter = true;
    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined';
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined';
    const requiresWaveformProcessing = mediaType === 'audio' && (uploadData.ptt === true || !!options.backgroundColor);
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio';
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation || requiresWaveformProcessing;
    let streamResult;
    try {
        streamResult = await (options.newsletter ? prepareStream : encryptedStream)(
            uploadData.media,
            options.mediaTypeOverride || mediaType,
            {
                logger,
                saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
                opts: options.options,
                isPtt: uploadData.ptt,
            }
        );
    } catch (streamErr) {
        throw streamErr;
    }
    const { mediaKey, encWriteStream, bodyPath, fileEncSha256, fileSha256, fileLength, didSaveToTmpPath } = streamResult;
    
    const fileEncSha256B64 = (options.newsletter ? fileSha256 : fileEncSha256 ?? fileSha256).toString('base64');

    const [{ mediaUrl, directPath, handle: uploadHandle }] = await Promise.all([
        (async () => {
            const result = await options.upload(encWriteStream, {
                fileEncSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs,
                newsletter: !!options.newsletter
            });
            return result;
        })(),
        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(bodyPath, mediaType, options);
                    uploadData.jpegThumbnail = thumbnail;
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width;
                        uploadData.height = originalImageDimensions.height;
                        logger?.debug('set dimensions');
                    }
                    logger?.debug('generated thumbnail');
                }
                if (requiresDurationComputation) {
                    try {
                        if (bodyPath) {
                            uploadData.seconds = await getAudioDuration(bodyPath, uploadData.mimetype);
                        }
                    } catch (err) {
                        uploadData.seconds = 0;
                    }
                    if (typeof uploadData.seconds !== 'number' || isNaN(uploadData.seconds)) {
                        uploadData.seconds = 0;
                    }
                    logger?.debug('computed audio duration');
                }
                if (requiresWaveformProcessing) {
                    try {
                        uploadData.waveform = await getAudioWaveform(bodyPath || encWriteStream, logger);
                    } catch (err) {
                    }
                    if (!uploadData.waveform) {
                        uploadData.waveform = new Uint8Array([0,99,0,99,0,99,0,99,88,99,0,99,0,55,0,99,0,99,0,99,0,99,0,99,88,99,0,99,0,55,0,99]);
                    }
                }
                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = await assertColor(options.backgroundColor);
                    logger?.debug('computed backgroundColor audio status');
                }
            } catch (error) {
                logger?.warn({ trace: error.stack }, 'failed to obtain extra info');
            }
        })()
    ]).finally(async () => {
        try {
            if (!Buffer.isBuffer(encWriteStream)) {
                encWriteStream.destroy?.();
            }
            if (didSaveToTmpPath && bodyPath) {
                await fs.unlink(bodyPath).catch(() => {});
            }
        } catch (error) {
            logger?.warn('failed to remove tmp file');
        }
    });
    const obj = WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: uploadHandle ? undefined : mediaUrl,
            directPath,
            mediaKey: mediaKey,
            fileEncSha256: fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: uploadHandle ? undefined : unixTimestampSeconds(),
            ...uploadData,
            media: undefined
        })
    });
    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage;
        delete obj.videoMessage;
    }
    if (uploadHandle) {
        obj._uploadHandle = uploadHandle;
    }
    if (mediaType === 'audio') {
        const am = obj.audioMessage;
        logger?.debug({ url: am?.url, directPath: am?.directPath, hasMediaKey: !!am?.mediaKey, seconds: am?.seconds, ptt: am?.ptt, mimetype: am?.mimetype, fileLength: am?.fileLength, uploadHandle }, '[blckrose-debug] audioMessage built');
    }
    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache');
        await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
    }
    return obj;
};
export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => {
    ephemeralExpiration = ephemeralExpiration || 0;
    const content = {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                    ephemeralExpiration
                }
            }
        }
    };
    return WAProto.Message.fromObject(content);
};
export const generateForwardMessageContent = (message, forceForward) => {
    let content = message.message;
    if (!content) {
        throw new Boom('no content in message', { statusCode: 400 });
    }
    content = normalizeMessageContent(content);
    content = proto.Message.decode(proto.Message.encode(content).finish());
    let key = Object.keys(content)[0];
    let score = content?.[key]?.contextInfo?.forwardingScore || 0;
    score += message.key.fromMe && !forceForward ? 0 : 1;
    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] };
        delete content.conversation;
        key = 'extendedTextMessage';
    }
    const key_ = content?.[key];
    if (score > 0) {
        key_.contextInfo = { forwardingScore: score, isForwarded: true };
    }
    else {
        key_.contextInfo = {};
    }
    return content;
};
export const hasNonNullishProperty = (message, key) => {
    return (typeof message === 'object' &&
        message !== null &&
        key in message &&
        message[key] !== null &&
        message[key] !== undefined);
};
function hasOptionalProperty(obj, key) {
    return typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null;
}
export const generateWAMessageContent = async (message, options) => {
    var _a, _b;
    let m = {};
    if (hasNonNullishProperty(message, 'text')) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = 0;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
                extContent.thumbnailEncSha256 = img.fileEncSha256;
            }
        }
        if (options.backgroundColor) {
            extContent.backgroundArgb = await assertColor(options.backgroundColor);
        }
        if (options.font) {
            extContent.font = options.font;
        }
        m.extendedTextMessage = extContent;
    }
    else if (hasNonNullishProperty(message, 'contacts')) {
        const contactLen = message.contacts.contacts.length;
        if (!contactLen) {
            throw new Boom('require atleast 1 contact', { statusCode: 400 });
        }
        if (contactLen === 1) {
            m.contactMessage = WAProto.Message.ContactMessage.create(message.contacts.contacts[0]);
        }
        else {
            m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(message.contacts);
        }
    }
    else if (hasNonNullishProperty(message, 'location')) {
        if (message.live) {
            m.liveLocationMessage = WAProto.Message.LiveLocationMessage.create(message.location);
        } else {
            m.locationMessage = WAProto.Message.LocationMessage.create(message.location);
        }
        const locType = message.live ? 'liveLocationMessage' : 'locationMessage';
        if (m[locType]) {
            m[locType].contextInfo = {
                ...(message.contextInfo || {}),
                ...(message.mentions ? { mentionedJid: message.mentions } : {})
            };
        }
    }
    else if (hasNonNullishProperty(message, 'react')) {
        if (!message.react.senderTimestampMs) {
            message.react.senderTimestampMs = Date.now();
        }
        m.reactionMessage = WAProto.Message.ReactionMessage.create(message.react);
    }
    else if (hasNonNullishProperty(message, 'delete')) {
        m.protocolMessage = {
            key: message.delete,
            type: WAProto.Message.ProtocolMessage.Type.REVOKE
        };
    }
    else if (hasNonNullishProperty(message, 'forward')) {
        m = generateForwardMessageContent(message.forward, message.force);
    }
    else if (hasNonNullishProperty(message, 'disappearingMessagesInChat')) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean'
            ? message.disappearingMessagesInChat
                ? WA_DEFAULT_EPHEMERAL
                : 0
            : message.disappearingMessagesInChat;
        m = prepareDisappearingMessageSettingContent(exp);
    }
    else if (hasNonNullishProperty(message, 'groupInvite')) {
        m.groupInviteMessage = {};
        m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode;
        m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration;
        m.groupInviteMessage.caption = message.groupInvite.text;
        m.groupInviteMessage.groupJid = message.groupInvite.jid;
        m.groupInviteMessage.groupName = message.groupInvite.subject;
        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview');
            if (pfpUrl) {
                const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher });
                if (resp.ok) {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    m.groupInviteMessage.jpegThumbnail = buf;
                }
            }
        }
    }
    else if (hasNonNullishProperty(message, 'pin')) {
        m.pinInChatMessage = {};
        m.messageContextInfo = {};
        m.pinInChatMessage.key = message.pin.key;
        m.pinInChatMessage.type = message.pin?.type || 1;
        m.pinInChatMessage.senderTimestampMs = message.pin?.time || Date.now();
        m.messageContextInfo.messageAddOnDurationInSecs = message.pin.type === 1 ? message.pin.time || 86400 : 0;
        m.messageContextInfo.messageAddOnExpiryType = proto.MessageContextInfo.MessageAddonExpiryType.STATIC;
    }
    else if (hasNonNullishProperty(message, 'keep')) {
        m.keepInChatMessage = {};
        m.keepInChatMessage.key = message.keep.key;
        m.keepInChatMessage.keepType = message.keep?.type || 1;
        m.keepInChatMessage.timestampMs = message.keep?.time || Date.now();
    }
    else if (hasNonNullishProperty(message, 'call')) {
        m.scheduledCallCreationMessage = {};
        m.scheduledCallCreationMessage.scheduledTimestampMs = message.call?.time || Date.now();
        m.scheduledCallCreationMessage.callType = message.call?.type || 1;
        m.scheduledCallCreationMessage.title = message.call?.name || 'Call Creation';
        m.scheduledCallCreationMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
    }
    else if (hasNonNullishProperty(message, 'paymentInvite')) {
        m.messageContextInfo = {};
        m.paymentInviteMessage = {};
        m.paymentInviteMessage.expiryTimestamp = message.paymentInvite?.expiry || 0;
        m.paymentInviteMessage.serviceType = message.paymentInvite?.type || 2;
        m.paymentInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
    }
    else if (hasNonNullishProperty(message, 'buttonReply')) {
        switch (message.type) {
            case 'list':
                m.listResponseMessage = {
                    title: message.buttonReply.title,
                    description: message.buttonReply.description,
                    singleSelectReply: {
                        selectedRowId: message.buttonReply.rowId
                    },
                    listType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT
                };
                break;
            case 'template':
                m.templateButtonReplyMessage = {
                    selectedDisplayText: message.buttonReply.displayText,
                    selectedId: message.buttonReply.id,
                    selectedIndex: message.buttonReply.index
                };
                break;
            case 'plain':
                m.buttonsResponseMessage = {
                    selectedButtonId: message.buttonReply.id,
                    selectedDisplayText: message.buttonReply.displayText,
                    type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
                };
                break;
            case 'interactive':
                m.interactiveResponseMessage = {
                    body: {
                        text: message.buttonReply.displayText,
                        format: proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1
                    },
                    nativeFlowResponseMessage: {
                        name: message.buttonReply.nativeFlows.name,
                        paramsJson: message.buttonReply.nativeFlows.paramsJson,
                        version: message.buttonReply.nativeFlows.version
                    }
                };
                break;
        }
    }
    else if (hasNonNullishProperty(message, 'album')) {
        const imageMessages = message.album.filter(item => 'image' in item);
        const videoMessages = message.album.filter(item => 'video' in item);
        m.albumMessage = WAProto.Message.AlbumMessage.fromObject({
            expectedImageCount: imageMessages.length,
            expectedVideoCount: videoMessages.length
        });
    }
    else if (hasNonNullishProperty(message, 'order')) {
        m.orderMessage = WAProto.Message.OrderMessage.fromObject(message.order);
        m.orderMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
    }
    else if (hasNonNullishProperty(message, 'payment')) {
        const requestPaymentMessage = {
            amount: {
                currencyCode: message.payment?.currency || 'IDR',
                offset: message.payment?.offset || 0,
                value: message.payment?.amount || 999999999
            },
            expiryTimestamp: message.payment?.expiry || 0,
            amount1000: (message.payment?.amount || 999999999) * 1000,
            currencyCodeIso4217: message.payment?.currency || 'IDR',
            requestFrom: message.payment?.from || '0@s.whatsapp.net',
            noteMessage: {
                extendedTextMessage: {
                    text: message.payment?.note || 'Notes'
                }
            },
            background: {
                placeholderArgb: message.payment?.image?.placeholderArgb || 4278190080,
                textArgb: message.payment?.image?.textArgb || 4294967295,
                subtextArgb: message.payment?.image?.subtextArgb || 4294967295,
                type: 1
            }
        };
        requestPaymentMessage.noteMessage.extendedTextMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m.requestPaymentMessage = requestPaymentMessage;
    }
    else if (hasNonNullishProperty(message, 'pollResult')) {
        if (!Array.isArray(message.pollResult.values)) {
            throw new Boom('Invalid pollResult values', { statusCode: 400 });
        }
        const pollResultSnapshotMessage = {
            name: message.pollResult.name,
            pollVotes: message.pollResult.values.map(([optionName, optionVoteCount]) => ({
                optionName,
                optionVoteCount
            }))
        };
        pollResultSnapshotMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m.pollResultSnapshotMessage = pollResultSnapshotMessage;
    }
    else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
        m.ptvMessage = videoMessage;
    }
    else if (hasNonNullishProperty(message, 'product')) {
        const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
        m.productMessage = WAProto.Message.ProductMessage.create({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage
            }
        });
    }
    else if (hasNonNullishProperty(message, 'listReply')) {
        m.listResponseMessage = { ...message.listReply };
    }
    else if (hasNonNullishProperty(message, 'event')) {
        m.eventMessage = {};
        const startTime = Math.floor(message.event.startDate.getTime() / 1000);
        if (message.event.call && options.getCallLink) {
            const token = await options.getCallLink(message.event.call, { startTime });
            m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token;
        }
        m.messageContextInfo = {
            messageSecret: message.event.messageSecret || randomBytes(32)
        };
        m.eventMessage.name = message.event.name;
        m.eventMessage.description = message.event.description;
        m.eventMessage.startTime = startTime;
        m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined;
        m.eventMessage.isCanceled = message.event.isCancelled ?? false;
        m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed;
        m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false;
        m.eventMessage.location = message.event.location;
    }
    else if (hasNonNullishProperty(message, 'poll')) {
        (_a = message.poll).selectableCount || (_a.selectableCount = 0);
        (_b = message.poll).toAnnouncementGroup || (_b.toAnnouncementGroup = false);
        if (!Array.isArray(message.poll.values)) {
            throw new Boom('Invalid poll values', { statusCode: 400 });
        }
        if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
            throw new Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
                statusCode: 400
            });
        }
        m.messageContextInfo = {
            messageSecret: message.poll.messageSecret || randomBytes(32)
        };
        const pollCreationMessage = {
            name: message.poll.name,
            selectableOptionsCount: message.poll.selectableCount,
            options: message.poll.values.map(optionName => ({ optionName }))
        };
        if (message.poll.toAnnouncementGroup) {
            m.pollCreationMessageV2 = pollCreationMessage;
        }
        else {
            if (message.poll.selectableCount === 1) {
                m.pollCreationMessageV3 = pollCreationMessage;
            }
            else {
                m.pollCreationMessage = pollCreationMessage;
            }
        }
    }
    else if (hasNonNullishProperty(message, 'stickerPack')) {
        const { zip } = _require('fflate');
        const { stickers, cover, name, publisher, packId, description } = message.stickerPack;
        const stickerData = {};
        const stickerPromises = stickers.map(async (s, i) => {
            const { stream } = await getStream(s.sticker);
            const buffer = await toBuffer(stream);
            const hash = sha256(buffer).toString('base64url');
            const fileName = `${i.toString().padStart(2, '0')}_${hash}.webp`;
            stickerData[fileName] = [new Uint8Array(buffer), { level: 0 }];
            return {
                fileName,
                mimetype: 'image/webp',
                isAnimated: s.isAnimated || false,
                isLottie: s.isLottie || false,
                emojis: s.emojis || [],
                accessibilityLabel: s.accessibilityLabel || ''
            };
        });
        const stickerMetadata = await Promise.all(stickerPromises);
        const zipBuffer = await new Promise((resolve, reject) => {
            zip(stickerData, (err, data) => {
                if (err) reject(err);
                else resolve(Buffer.from(data));
            });
        });
        const coverBuffer = await toBuffer((await getStream(cover)).stream);
        const stickerPackUpload = await encryptedStream(zipBuffer, 'sticker', {
            logger: options.logger,
            opts: options.options
        });
        const { getMediaKeys: _getMediaKeys } = await import('./messages-media.js');
        const _Crypto = (await import('crypto')).default;
        const { cipherKey: covCipherKey, iv: covIv, macKey: covMacKey } = await _getMediaKeys(
            stickerPackUpload.mediaKey, 'sticker'
        );
        const covAes = _Crypto.createCipheriv('aes-256-cbc', covCipherKey, covIv);
        let covHmac = _Crypto.createHmac('sha256', covMacKey).update(covIv);
        const covSha256Plain = _Crypto.createHash('sha256').update(coverBuffer).digest();
        const covEncPart1 = covAes.update(coverBuffer);
        const covEncPart2 = covAes.final();
        covHmac.update(covEncPart1).update(covEncPart2);
        const covMac = covHmac.digest().slice(0, 10);
        const covEncBody = Buffer.concat([covEncPart1, covEncPart2, covMac]);
        const covFileEncSha256 = _Crypto.createHash('sha256').update(covEncBody).digest();
        const [stickerPackUploadResult, coverUploadResult] = await Promise.all([
            options.upload(stickerPackUpload.encWriteStream, {
                fileEncSha256B64: stickerPackUpload.fileEncSha256.toString('base64'),
                mediaType: 'sticker',
                timeoutMs: options.mediaUploadTimeoutMs
            }),
            options.upload(covEncBody, {
                fileEncSha256B64: covFileEncSha256.toString('base64'),
                mediaType: 'sticker',
                timeoutMs: options.mediaUploadTimeoutMs
            })
        ]);
        let thumbWidth = 320, thumbHeight = 320;
        try {
            const { extractImageThumb } = await import('./messages-media.js');
            const { original } = await extractImageThumb(coverBuffer);
            if (original?.width) thumbWidth = original.width;
            if (original?.height) thumbHeight = original.height;
        } catch (_) {}
        const imageDataHash = sha256(coverBuffer).toString('base64');
        const stickerPackId = packId || generateMessageIDV2();
        m.stickerPackMessage = {
            name,
            publisher,
            stickerPackId,
            packDescription: description,
            stickerPackOrigin: WAProto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
            stickerPackSize: stickerPackUpload.fileLength,
            stickers: stickerMetadata,
            fileSha256: stickerPackUpload.fileSha256,
            fileEncSha256: stickerPackUpload.fileEncSha256,
            mediaKey: stickerPackUpload.mediaKey,
            directPath: stickerPackUploadResult.directPath,
            fileLength: stickerPackUpload.fileLength,
            mediaKeyTimestamp: unixTimestampSeconds(),
            trayIconFileName: `${stickerPackId}.png`,
            imageDataHash,
            thumbnailDirectPath: coverUploadResult.directPath,
            thumbnailSha256: covSha256Plain,
            thumbnailEncSha256: covFileEncSha256,
            thumbnailHeight: thumbHeight,
            thumbnailWidth: thumbWidth
        };
        m.stickerPackMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
    }
    else if (hasNonNullishProperty(message, 'adminInvite')) {
        m.newsletterAdminInviteMessage = {};
        m.newsletterAdminInviteMessage.newsletterJid = message.adminInvite.jid;
        m.newsletterAdminInviteMessage.newsletterName = message.adminInvite.name;
        m.newsletterAdminInviteMessage.caption = message.adminInvite.caption;
        m.newsletterAdminInviteMessage.inviteExpiration = message.adminInvite.expiration;
        if (message.adminInvite.jpegThumbnail) {
            m.newsletterAdminInviteMessage.jpegThumbnail = message.adminInvite.jpegThumbnail;
        } else if (options.getProfilePicUrl) {
            try {
                const pfpUrl = await options.getProfilePicUrl(message.adminInvite.jid);
                if (pfpUrl) {
                    const { thumbnail } = await generateThumbnail(pfpUrl, 'image');
                    m.newsletterAdminInviteMessage.jpegThumbnail = thumbnail;
                }
            } catch (_) {}
        }
        m.newsletterAdminInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
    }
    else if (hasNonNullishProperty(message, 'sharePhoneNumber')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        };
    }
    else if (hasNonNullishProperty(message, 'requestPhoneNumber')) {
        m.requestPhoneNumberMessage = {};
    }
    else if (hasNonNullishProperty(message, 'limitSharing')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
            limitSharing: {
                sharingLimited: message.limitSharing === true,
                trigger: 1,
                limitSharingSettingTimestamp: Date.now(),
                initiatedByMe: true
            }
        };
    }
    else if ('interactiveMessage' in message && !!message.interactiveMessage) {
        m = { interactiveMessage: message.interactiveMessage };
    }
    else {
        m = await prepareWAMessageMedia(message, options);
    }
    if ('sections' in message && !!message.sections) {
        const listMessage = {
            title: message.title,
            buttonText: message.buttonText,
            footerText: message.footer,
            description: message.text,
            sections: message.sections,
            listType: proto.Message.ListMessage.ListType.SINGLE_SELECT
        };
        listMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m = { listMessage };
    }
    else if ('productList' in message && !!message.productList) {
        const thumbnail = message.thumbnail ? await generateThumbnail(message.thumbnail, 'image') : null;
        const listMessage = {
            title: message.title,
            buttonText: message.buttonText,
            footerText: message.footer,
            description: message.text,
            productListInfo: {
                productSections: message.productList,
                headerImage: {
                    productId: message.productList[0].products[0].productId,
                    jpegThumbnail: thumbnail?.thumbnail || null
                },
                businessOwnerJid: message.businessOwnerJid
            },
            listType: proto.Message.ListMessage.ListType.PRODUCT_LIST
        };
        listMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m = { listMessage };
    }
    else if ('buttons' in message && !!message.buttons) {
        const buttonsMessage = {
            buttons: message.buttons.map(b => ({ ...b, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE }))
        };
        if ('text' in message) {
            buttonsMessage.contentText = message.text;
            buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.EMPTY;
        }
        else {
            if ('caption' in message) {
                buttonsMessage.contentText = message.caption;
            }
            const type = Object.keys(m)[0].replace('Message', '').toUpperCase();
            buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType[type];
            Object.assign(buttonsMessage, m);
        }
        if ('footer' in message && !!message.footer) {
            buttonsMessage.footerText = message.footer;
        }
        if ('title' in message && !!message.title) {
            buttonsMessage.text = message.title;
            buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.TEXT;
        }
        buttonsMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m = { buttonsMessage };
    }
    else if ('templateButtons' in message && !!message.templateButtons) {
        const hydratedTemplate = {
            hydratedButtons: message.templateButtons
        };
        if ('text' in message) {
            hydratedTemplate.hydratedContentText = message.text;
        }
        else {
            if ('caption' in message) {
                hydratedTemplate.hydratedContentText = message.caption;
            }
            Object.assign(hydratedTemplate, m);
        }
        if ('footer' in message && !!message.footer) {
            hydratedTemplate.hydratedFooterText = message.footer;
        }
        hydratedTemplate.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m = { templateMessage: { fourRowTemplate: hydratedTemplate, hydratedTemplate } };
    }
    else if ('interactiveButtons' in message && !!message.interactiveButtons) {
        const interactiveMessage = {
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                buttons: message.interactiveButtons,
            })
        };
        if ('text' in message) {
            interactiveMessage.body = { text: message.text };
        }
        else if ('caption' in message) {
            interactiveMessage.body = { text: message.caption };
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: message?.media ?? false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = { text: message.footer };
        }
        if ('title' in message && !!message.title) {
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: message?.media ?? false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('contextInfo' in message && !!message.contextInfo) {
            interactiveMessage.contextInfo = message.contextInfo;
        }
        if ('mentions' in message && !!message.mentions) {
            interactiveMessage.contextInfo = { mentionedJid: message.mentions };
        }
        m = { interactiveMessage };
    }
    else if ('shop' in message && !!message.shop) {
        const interactiveMessage = {
            shopStorefrontMessage: proto.Message.InteractiveMessage.ShopMessage.fromObject({
                surface: message.shop,
                id: message.id
            })
        };
        if ('text' in message) {
            interactiveMessage.body = { text: message.text };
        }
        else if ('caption' in message) {
            interactiveMessage.body = { text: message.caption };
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: message?.media ?? false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = { text: message.footer };
        }
        if ('title' in message && !!message.title) {
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: message?.media ?? false,
            };
            Object.assign(interactiveMessage.header, m);
        }
        if ('contextInfo' in message && !!message.contextInfo) {
            interactiveMessage.contextInfo = message.contextInfo;
        }
        if ('mentions' in message && !!message.mentions) {
            interactiveMessage.contextInfo = { mentionedJid: message.mentions };
        }
        m = { interactiveMessage };
    }
    else if ('collection' in message && !!message.collection) {
        const interactiveMessage = {
            collectionMessage: {
                bizJid: message.collection.bizJid,
                id: message.collection.id,
                messageVersion: message?.collection?.version
            }
        };
        if ('text' in message) {
            interactiveMessage.body = { text: message.text };
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: false
            };
        }
        else {
            if ('caption' in message) {
                interactiveMessage.body = { text: message.caption };
                interactiveMessage.header = {
                    title: message.title,
                    subtitle: message.subtitle,
                    hasMediaAttachment: message.hasMediaAttachment ? message.hasMediaAttachment : false,
                    ...Object.assign(interactiveMessage, m)
                };
            }
        }
        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = { text: message.footer };
        }
        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m = { interactiveMessage };
    }
    else if ('cards' in message && !!message.cards) {
        const slides = await Promise.all(message.cards.map(async (slide) => {
            const { image, video, product, title, body, footer, buttons } = slide;
            let header;
            if (product) {
                const { imageMessage } = await prepareWAMessageMedia({ image: product.productImage, ...options }, options);
                header = {
                    productMessage: {
                        product: {
                            ...product,
                            productImage: imageMessage,
                        },
                        ...slide
                    }
                };
            }
            else if (image) {
                header = await prepareWAMessageMedia({ image: image, ...options }, options);
            }
            else if (video) {
                header = await prepareWAMessageMedia({ video: video, ...options }, options);
            }
            return {
                header: {
                    title,
                    hasMediaAttachment: true,
                    ...header
                },
                body: { text: body },
                footer: { text: footer },
                nativeFlowMessage: { buttons }
            };
        }));
        const interactiveMessage = {
            carouselMessage: { cards: slides }
        };
        if ('text' in message) {
            interactiveMessage.body = { text: message.text };
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: false
            };
        }
        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = { text: message.footer };
        }
        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? { mentionedJid: message.mentions } : {})
        };
        m = { interactiveMessage };
    }
    if (hasOptionalProperty(message, 'ephemeral') && !!message.ephemeral) {
        m = { ephemeralMessage: { message: m } };
    }
    if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
        m = { viewOnceMessageV2: { message: m } };
    }
    if (hasOptionalProperty(message, 'viewOnceExt') && !!message.viewOnceExt) {
        m = { viewOnceMessageV2Extension: { message: m } };
    }
    if (hasOptionalProperty(message, 'mentions') && message.mentions?.length) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.mentionedJid = message.mentions;
        }
        else if (key) {
            key.contextInfo = {
                mentionedJid: message.mentions
            };
        }
    }
    if (hasOptionalProperty(message, 'edit')) {
        m = {
            protocolMessage: {
                key: message.edit,
                editedMessage: m,
                timestampMs: Date.now(),
                type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            }
        };
    }
    if (hasOptionalProperty(message, 'contextInfo') && !!message.contextInfo) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
        }
        else if (key) {
            key.contextInfo = message.contextInfo;
        }
    }
    if (shouldIncludeReportingToken(m) && !options.newsletter) {
        m.messageContextInfo = m.messageContextInfo || {};
        if (!m.messageContextInfo.messageSecret) {
            m.messageContextInfo.messageSecret = randomBytes(32);
        }
    }
    return WAProto.Message.create(m);
};
export const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) {
        options.timestamp = new Date();
    }
    const innerMessage = normalizeMessageContent(message);
    const key = getContentType(innerMessage);
    const timestamp = unixTimestampSeconds(options.timestamp);
    const { quoted, userJid } = options;
    if (quoted && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe ? userJid : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
        let quotedMsg = normalizeMessageContent(quoted.message);
        const msgType = getContentType(quotedMsg);
        quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] });
        const quotedContent = quotedMsg[msgType];
        if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
            delete quotedContent.contextInfo;
        }
        const contextInfo = ('contextInfo' in innerMessage[key] && innerMessage[key]?.contextInfo) || {};
        contextInfo.participant = jidNormalizedUser(participant);
        contextInfo.stanzaId = quoted.key.id;
        contextInfo.quotedMessage = quotedMsg;
        if (jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid;
        }
        if (contextInfo && innerMessage[key]) {
            innerMessage[key].contextInfo = contextInfo;
        }
    }
    if (!!options?.ephemeralExpiration && key !== 'protocolMessage' && key !== 'ephemeralMessage' && !isJidNewsletter(jid)) {
        innerMessage[key].contextInfo = {
            ...(innerMessage[key].contextInfo || {}),
            expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL
        };
    }
    message = WAProto.Message.create(message);
    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generateMessageIDV2()
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined,
        status: WAMessageStatus.PENDING
    };
    return WAProto.WebMessageInfo.fromObject(messageJSON);
};
export const generateWAMessage = async (jid, content, options) => {
    options.logger = options?.logger?.child({ msgId: options.messageId });
    const _isNewsletter = typeof jid === 'string' && jid.endsWith('@newsletter');
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { newsletter: _isNewsletter, ...options, jid }), options);
};
export const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content);
        const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
        return key;
    }
};
export const getMediaTypeFromContentType = (contentType, content) => {
    if (!contentType)
        return undefined;
    if (contentType === 'ptvMessage')
        return 'ptv';
    if (contentType === 'audioMessage' && content?.[contentType]?.ptt)
        return 'ptt';
    if (contentType === 'videoMessage' && content?.[contentType]?.gifPlayback)
        return 'gif';
    return contentType.replace('Message', '');
};
export const normalizeMessageContent = (content) => {
    if (!content) {
        return undefined;
    }
    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessage(content);
        if (!inner) {
            break;
        }
        content = inner.message;
    }
    return content;
    function getFutureProofMessage(message) {
        return (message?.ephemeralMessage ||
            message?.viewOnceMessage ||
            message?.documentWithCaptionMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension ||
            message?.editedMessage ||
            message?.associatedChildMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2);
    }
};
export const extractMessageContent = (content) => {
    const extractFromTemplateMessage = (msg) => {
        if (msg.imageMessage) {
            return { imageMessage: msg.imageMessage };
        }
        else if (msg.documentMessage) {
            return { documentMessage: msg.documentMessage };
        }
        else if (msg.videoMessage) {
            return { videoMessage: msg.videoMessage };
        }
        else if (msg.locationMessage) {
            return { locationMessage: msg.locationMessage };
        }
        else {
            return {
                conversation: 'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : ''
            };
        }
    };
    content = normalizeMessageContent(content);
    if (content?.buttonsMessage) {
        return extractFromTemplateMessage(content.buttonsMessage);
    }
    if (content?.templateMessage?.hydratedFourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate);
    }
    if (content?.templateMessage?.hydratedTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate);
    }
    if (content?.templateMessage?.fourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate);
    }
    return content;
};
export const getDevice = (id) => /^3A.{18}$/.test(id)
    ? 'ios'
    : /^3E.{20}$/.test(id)
        ? 'web'
        : /^(.{21}|.{32})$/.test(id)
            ? 'android'
            : /^(3F|.{18}$)/.test(id)
                ? 'desktop'
                : 'unknown';
export const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt = msg.userReceipt || [];
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid);
    if (recp) {
        Object.assign(recp, receipt);
    }
    else {
        msg.userReceipt.push(receipt);
    }
};
export const updateMessageWithReaction = (msg, reaction) => {
    const authorID = getKeyAuthor(reaction.key);
    const reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID);
    reaction.text = reaction.text || '';
    reactions.push(reaction);
    msg.reactions = reactions;
};
export const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = getKeyAuthor(update.pollUpdateMessageKey);
    const reactions = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID);
    if (update.vote?.selectedOptions?.length) {
        reactions.push(update);
    }
    msg.pollUpdates = reactions;
};
export const updateMessageWithEventResponse = (msg, update) => {
    const authorID = getKeyAuthor(update.eventResponseMessageKey);
    const responses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID);
    responses.push(update);
    msg.eventResponses = responses;
};
export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    const opts = message?.pollCreationMessage?.options ||
        message?.pollCreationMessageV2?.options ||
        message?.pollCreationMessageV3?.options ||
        [];
    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = sha256(Buffer.from(opt.optionName || '')).toString();
        acc[hash] = {
            name: opt.optionName || '',
            voters: []
        };
        return acc;
    }, {});
    for (const update of pollUpdates || []) {
        const { vote } = update;
        if (!vote) {
            continue;
        }
        for (const option of vote.selectedOptions || []) {
            const hash = option.toString();
            let data = voteHashMap[hash];
            if (!data) {
                voteHashMap[hash] = {
                    name: 'Unknown',
                    voters: []
                };
                data = voteHashMap[hash];
            }
            voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId));
        }
    }
    return Object.values(voteHashMap);
}
export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
    const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE'];
    const responseMap = {};
    for (const type of responseTypes) {
        responseMap[type] = {
            response: type,
            responders: []
        };
    }
    for (const update of eventResponses || []) {
        const responseType = update.eventResponse || 'UNKNOWN';
        if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
            responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId));
        }
    }
    return Object.values(responseMap);
}
export const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {};
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`;
            if (!keyMap[uqKey]) {
                keyMap[uqKey] = {
                    jid: remoteJid,
                    participant: participant,
                    messageIds: []
                };
            }
            keyMap[uqKey].messageIds.push(id);
        }
    }
    return Object.values(keyMap);
};
const REUPLOAD_REQUIRED_STATUS = [410, 404];
export const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg().catch(async (error) => {
        if (ctx &&
            typeof error?.status === 'number' && REUPLOAD_REQUIRED_STATUS.includes(error.status)) {
            ctx.logger.info({ key: message.key }, 'sending reupload media request...');
            message = await ctx.reuploadRequest(message);
            const result = await downloadMsg();
            return result;
        }
        throw error;
    });
    return result;
    async function downloadMsg() {
        const mContent = extractMessageContent(message.message);
        if (!mContent) {
            throw new Boom('No message present', { statusCode: 400, data: message });
        }
        const contentType = getContentType(mContent);
        let mediaType = getMediaTypeFromContentType(contentType, mContent);
        const media = mContent[contentType];
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new Boom(`"${contentType}" message is not a media message`);
        }
        let download;
        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey
            };
            mediaType = 'thumbnail-link';
        }
        else {
            download = media;
        }
        const stream = await downloadContentFromMessage(download, mediaType, options);
        if (type === 'buffer') {
            const bufferArray = [];
            for await (const chunk of stream) {
                bufferArray.push(chunk);
            }
            return Buffer.concat(bufferArray);
        }
        return stream;
    }
};
export const assertMediaContent = (content) => {
    content = extractMessageContent(content);
    const mediaContent = content?.documentMessage ||
        content?.imageMessage ||
        content?.videoMessage ||
        content?.audioMessage ||
        content?.stickerMessage;
    if (!mediaContent) {
        throw new Boom('given message is not a media message', { statusCode: 400, data: content });
    }
    return mediaContent;
};

export const patchMessageForMdIfRequired = (message) => {
    if (message?.buttonsMessage ||
        message?.templateMessage ||
        message?.listMessage ||
        message?.interactiveMessage?.nativeFlowMessage
    ) {
        message = {
            viewOnceMessageV2Extension: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {}
                    },
                    ...message
                }
            }
        };
    }
    return message;
};
export const prepareAlbumMessageContent = async (jid, albums, options) => {
    let mediaHandle;
    let mediaMsg;
    const message = [];
    const albumMsg = generateWAMessageFromContent(jid, {
        albumMessage: {
            expectedImageCount: albums.filter(item => 'image' in item).length,
            expectedVideoCount: albums.filter(item => 'video' in item).length
        }
    }, options);
    await options.sock.relayMessage(jid, albumMsg.message, { messageId: albumMsg.key.id });
    for (const i in albums) {
        const media = albums[i];
        if ('image' in media) {
            mediaMsg = await generateWAMessage(jid, { image: media.image, ...media, ...options }, {
                userJid: options.userJid,
                upload: async (encFilePath, opts) => {
                    const up = await options.sock.waUploadToServer(encFilePath, { ...opts, newsletter: isJidNewsletter(jid) });
                    mediaHandle = up.handle;
                    return up;
                },
                ...options
            });
        } else if ('video' in media) {
            mediaMsg = await generateWAMessage(jid, { video: media.video, ...media, ...options }, {
                userJid: options.userJid,
                upload: async (encFilePath, opts) => {
                    const up = await options.sock.waUploadToServer(encFilePath, { ...opts, newsletter: isJidNewsletter(jid) });
                    mediaHandle = up.handle;
                    return up;
                },
                ...options
            });
        }
        if (mediaMsg) {
            mediaMsg.message.messageContextInfo = {
                messageSecret: randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: albumMsg.key
                }
            };
        }
        message.push(mediaMsg);
    }
    return message;
};

export const getQuotedMsg = (msg, options = {}) => {
    const { debug = false } = options;
    const msgContent = normalizeMessageContent(msg?.message);
    if (!msgContent) return null;
    const msgType = getContentType(msgContent);
    if (!msgType) return null;
    const innerMsg = msgContent[msgType];
    if (!innerMsg) return null;
    const contextInfo = innerMsg.contextInfo;
    if (!contextInfo?.stanzaId || !contextInfo?.quotedMessage) return null;
    const participant = contextInfo.participant || msg.key?.participant || msg.key?.remoteJid || '';
    const quotedMsgContent = normalizeMessageContent(contextInfo.quotedMessage);
    const quotedMsgType = getContentType(quotedMsgContent);
    const quotedInnerMsg = quotedMsgType ? quotedMsgContent?.[quotedMsgType] : null;
    const quotedMentionedJid = quotedInnerMsg?.contextInfo?.mentionedJid || [];
    const quotedText = quotedInnerMsg?.text || quotedInnerMsg?.caption || quotedInnerMsg?.conversation || '';

    const result = {
        key: {
            id: contextInfo.stanzaId,
            remoteJid: contextInfo.remoteJid || msg.key?.remoteJid || '',
            participant: participant,
            fromMe: false
        },
        message: contextInfo.quotedMessage,
        participant,
        sender: participant,
        text: quotedText,
        type: quotedMsgType || '',
        mentionedJid: quotedMentionedJid,
        _rawContextInfo: debug ? contextInfo : undefined
    };

    if (debug) {
        const hasLidInText = typeof quotedText === 'string' && /@\d{13,20}/.test(quotedText);
        const hasLidInMentioned = quotedMentionedJid.some(j => j?.endsWith('@lid'));
        const hasLidParticipant = participant?.endsWith('@lid');
        console.log('[getQuotedMsg DEBUG]', JSON.stringify({
            stanzaId: contextInfo.stanzaId,
            participant,
            participantIsLid: hasLidParticipant,
            quotedText,
            textHasLid: hasLidInText,
            mentionedJid: quotedMentionedJid,
            mentionedHasLid: hasLidInMentioned,
            quotedMsgType
        }, null, 2));
    }

    return result;
};
