import { Boom, createZip, detectFileType } from '../Addon/index.js';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from '../../WAProto/index.js';
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, DEFAULT_URL, LIBRARY_NAME, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { AssociationType, ButtonHeaderType, ButtonType, CarouselCardType, ListType, ProtocolType, WAMessageStatus, WAProto } from '../Types/index.js';
import { isLidUser, isPnUser, isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { sha256 } from './crypto.js';
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js';
import { downloadContentFromMessage, encryptedStream, generateThumbnail, getAudioData, getImageProcessingLibrary, getMediaKeys, getRawMediaUploadData, getStream, toBuffer } from './messages-media.js';
import { prepareRichResponseMessage } from './rich-message-utils.js';
import { shouldIncludeReportingToken } from './reporting-utils.js';
const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg'
};
const MIMETYPE_CATEGORY = {
    image: 'image/',
    video: 'video/',
    sticker: 'image/'
};
const resolveMimetype = (mediaType, detectedMime) => {
    const fallback = MIMETYPE_MAP[mediaType];
    if (!detectedMime)
        return fallback;
    if (mediaType === 'audio') {
        if (detectedMime.startsWith('audio/'))
            return detectedMime;
        return detectedMime.startsWith('video/') ? detectedMime.replace('video/', 'audio/') : fallback;
    }
    const category = MIMETYPE_CATEGORY[mediaType];
    if (category && !detectedMime.startsWith(category))
        return fallback;
    return detectedMime;
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
const ensureMessageProto = (m) => {
    if (m instanceof WAProto.Message)
        return m;
    return WAProto.Message.fromObject(m);
};
const assertColor = (color) => {
    if (typeof color === 'number') {
        return color < 0
            ? 0xffffffff + color + 1
            : color;
    }
    let hex = color.trim();
    if (hex.charCodeAt(0) === 35) {
        hex = hex.slice(1);
    }
    if (hex.length <= 6) {
        hex = hex.padStart(6, '0');
        hex = 'FF' + hex;
    }
    return parseInt(hex, 16);
};
const resolveRemoteOpts = options => options.maxContentLength != null ? { ...options.options, maxContentLength: options.maxContentLength } : options.options;
export const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger;
    let mediaType;
    for (const key of MEDIA_KEYS) {
        if (key in message) {
            mediaType = key;
            break;
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
        uploadData.fileName = LIBRARY_NAME;
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
    const isNewsletter = isJidNewsletter(options.jid);
    const requiresMimetypeDetection = !uploadData.mimetype;
    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined';
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined';
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined';
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true;
    if (isNewsletter) {
        logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter');
        const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger);
        const fileSha256B64 = fileSha256.toString('base64');
        const [{ mediaUrl, directPath, thumbnailDirectPath, thumbnailSha256 }] = await Promise.all([
            (async () => {
                const result = await options.upload(filePath, {
                    fileEncSha256B64: fileSha256B64,
                    mediaType: mediaType,
                    timeoutMs: options.mediaUploadTimeoutMs,
                    newsletter: isNewsletter
                });
                logger?.debug({ mediaType, cacheableKey }, 'uploaded media');
                return result;
            })(),
            (async () => {
                try {
                    if (requiresMimetypeDetection) {
                        const { mime } = uploadData.ptt === true ? { mime: MIMETYPE_MAP['audio'] } : (await detectFileType(filePath));
                        uploadData.mimetype = resolveMimetype(mediaType, mime);
                        logger?.debug('detected media mime');
                    }
                    if (requiresDurationComputation || requiresWaveformProcessing) {
                        const computedData = await getAudioData(filePath, logger);
                        uploadData.seconds = computedData.durationSeconds;
                        uploadData.waveform = computedData.waveform;
                        logger?.debug('computed audio data');
                    }
                    if (requiresAudioBackground) {
                        uploadData.backgroundArgb = assertColor(options.backgroundColor);
                        logger?.debug('computed backgroundColor audio');
                    }
                }
                catch (error) {
                    logger?.warn({ trace: error.stack }, 'failed to obtain extra info');
                }
            })()
        ]).finally(async () => {
            try {
                await fs.unlink(filePath);
                logger?.debug('removed tmp files');
            }
            catch (error) {
                logger?.warn('failed to remove tmp file');
            }
        });
        if (!uploadData.mimetype) {
            uploadData.mimetype = MIMETYPE_MAP[mediaType];
        }
        const obj = ensureMessageProto({
            [`${mediaType}Message`]: {
                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                thumbnailDirectPath,
                thumbnailSha256,
                ...uploadData,
                media: undefined
            }
        });
        if (uploadData.ptv) {
            obj.ptvMessage = obj.videoMessage;
            delete obj.videoMessage;
        }
        if (obj.stickerMessage) {
            obj.stickerMessage.stickerSentTs = Date.now();
        }
        if (cacheableKey) {
            logger?.debug({ cacheableKey }, 'set cache');
            await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
        }
        return obj;
    }
    const requiresOriginalForSomeProcessing = requiresMimetypeDetection || requiresDurationComputation || requiresWaveformProcessing || requiresThumbnailComputation;
    const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: resolveRemoteOpts(options)
    });
    const fileEncSha256B64 = fileEncSha256.toString('base64');
    const [{ mediaUrl, directPath }] = await Promise.all([
        (async () => {
            const result = await options.upload(encFilePath, {
                fileEncSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            });
            logger?.debug({ mediaType, cacheableKey }, 'uploaded media');
            return result;
        })(),
        (async () => {
            try {
                if (requiresMimetypeDetection) {
                    const { mime } = uploadData.ptt === true ? { mime: MIMETYPE_MAP['audio'] } : (await detectFileType(originalFilePath));
                    uploadData.mimetype = resolveMimetype(mediaType, mime);
                    logger?.debug('detected media mime');
                }
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(originalFilePath, mediaType, options);
                    uploadData.jpegThumbnail = thumbnail;
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width;
                        uploadData.height = originalImageDimensions.height;
                        logger?.debug('set dimensions');
                    }
                    logger?.debug('generated thumbnail');
                }
                if (requiresDurationComputation || requiresWaveformProcessing) {
                    const computedData = await getAudioData(originalFilePath, logger);
                    uploadData.seconds = computedData.durationSeconds;
                    uploadData.waveform = computedData.waveform;
                    logger?.debug('computed audio data');
                }
                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = assertColor(options.backgroundColor);
                    logger?.debug('computed backgroundColor audio status');
                }
            }
            catch (error) {
                logger?.warn({ trace: error.stack }, 'failed to obtain extra info');
            }
        })()
    ]).finally(async () => {
        try {
            await fs.unlink(encFilePath);
            if (originalFilePath) {
                await fs.unlink(originalFilePath);
            }
            logger?.debug('removed tmp files');
        }
        catch (error) {
            logger?.warn('failed to remove tmp file');
        }
    });
    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType];
    }
    const obj = ensureMessageProto({
        [`${mediaType}Message`]: {
            url: mediaUrl,
            directPath,
            mediaKey,
            fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: unixTimestampSeconds(),
            ...uploadData,
            media: undefined
        }
    });
    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage;
        delete obj.videoMessage;
    }
    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache');
        await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
    }
    return obj;
};
const prepareProductMessage = async (message, options) => {
    if (!message.businessOwnerJid) {
        throw new Boom('"businessOwnerJid" is missing from the content', { statusCode: 400 });
    }
    const { imageMessage } = await prepareWAMessageMedia({ image: message.image || message.product.productImage }, options);
    const { image, ...content } = message;
    content.product = {
        currencyCode: 'IDR',
        priceAmount1000: 1000,
        title: LIBRARY_NAME,
        ...message.product,
        productImage: imageMessage
    };
    return content;
};
const encryptMediaBuffer = async (buf, mediaKey) => {
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, 'sticker-pack');
    const aes = createCipheriv('aes-256-cbc', cipherKey, iv);
    const hmac = createHmac('sha256', macKey).update(iv);
    const encPart1 = aes.update(buf);
    const encPart2 = aes.final();
    hmac.update(encPart1).update(encPart2);
    const mac = hmac.digest().subarray(0, 10);
    const encBody = Buffer.concat([encPart1, encPart2, mac]);
    const fileEncSha256 = createHash('sha256').update(encPart1).update(encPart2).update(mac).digest();
    const fileSha256 = createHash('sha256').update(buf).digest();
    return { encBody, fileSha256, fileEncSha256 };
};
const generateStickerPackMessage = async (stickerPack, options) => {
    const { stickers, cover, name, publisher, packId, description } = stickerPack;
    if (!stickers || stickers.length === 0) {
        throw new Boom('Sticker pack must contain at least one sticker', { statusCode: 400 });
    }
    if (stickers.length > 120) {
        throw new Boom('Sticker pack exceeds the maximum limit of 120 stickers', { statusCode: 400 });
    }
    if (!cover) {
        throw new Boom('Sticker pack must contain a cover', { statusCode: 400 });
    }
    const lib = await getImageProcessingLibrary();
    const hasSharp = 'sharp' in lib && !!lib.sharp?.default;
    const hasJimp = 'jimp' in lib && !!lib.jimp?.Jimp;
    const stickerPackId = packId || generateMessageIDV2();
    const stickerData = [];
    const stickerMetadata = await Promise.all(
        stickers.map(async (s, i) => {
            const source = s.sticker ?? s.data;
            if (!source) {
                throw new Boom(`Sticker at index ${i} is missing its image data`, { statusCode: 400 });
            }
            const { stream } = await getStream(source);
            const buffer = await toBuffer(stream);
            let webpBuffer;
            let isAnimated = false;
            if (isWebPBuffer(buffer)) {
                webpBuffer = buffer;
                isAnimated = isAnimatedWebP(buffer);
            } else if (hasSharp) {
                webpBuffer = await lib.sharp.default(buffer).resize(512, 512, { fit: 'inside' }).webp({ quality: 80 }).toBuffer();
            } else if (hasJimp) {
                const jimpImage = await lib.jimp.Jimp.read(buffer);
                webpBuffer = await jimpImage.resize({ w: 512, h: 512, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/webp');
            } else {
                webpBuffer = buffer;
            }
            if (webpBuffer.length > 1024 * 1024) {
                throw new Boom(`Sticker at index ${i} exceeds the 1MB size limit`, { statusCode: 400 });
            }
            const fileName = `${i + 1}.webp`;
            stickerData[i] = { name: fileName, data: new Uint8Array(webpBuffer) };
            return {
                fileName,
                mimetype: 'image/webp',
                isAnimated: s.isAnimated !== void 0 ? s.isAnimated : isAnimated,
                isLottie: s.isLottie || false,
                emojis: s.emojis || [],
                accessibilityLabel: s.accessibilityLabel || ''
            };
        })
    );
    const { stream: coverStream } = await getStream(cover);
    const coverBuffer = await toBuffer(coverStream);
    const coverFileName = `${stickerPackId}.webp`;
    stickerData[stickers.length] = { name: coverFileName, data: new Uint8Array(coverBuffer) };
    const zipBuffer = Buffer.from(await createZip(stickerData));
    const isNewsletter = isJidNewsletter(options.jid);
    const logger = options.logger;
    const mediaKey = isNewsletter ? undefined : randomBytes(32);
    const uploadPart = async (buffer, mediaType, tmpPrefix) => {
        if (isNewsletter) {
            const { filePath, fileSha256 } = await getRawMediaUploadData(buffer, mediaType, logger);
            try {
                const result = await options.upload(filePath, {
                    fileEncSha256B64: fileSha256.toString('base64'),
                    mediaType,
                    timeoutMs: options.mediaUploadTimeoutMs,
                    newsletter: isNewsletter
                });
                return { directPath: result.directPath, fileSha256, fileEncSha256: undefined };
            }
            finally {
                await fs.unlink(filePath).catch(() => logger?.warn('failed to remove tmp file'));
            }
        }
        const enc = await encryptMediaBuffer(buffer, mediaKey);
        const encPath = join(tmpdir(), tmpPrefix + stickerPackId);
        await fs.writeFile(encPath, enc.encBody);
        try {
            const result = await options.upload(encPath, {
                fileEncSha256B64: enc.fileEncSha256.toString('base64'),
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            });
            return { directPath: result.directPath, fileSha256: enc.fileSha256, fileEncSha256: enc.fileEncSha256 };
        }
        finally {
            await fs.unlink(encPath).catch(() => { });
        }
    };
    const zipUpload = await uploadPart(zipBuffer, 'sticker-pack', 'stickerpack_');
    const thumbUpload = await uploadPart(coverBuffer, 'thumbnail-sticker-pack', 'stickerthumb_');
    const imageDataHash = sha256(coverBuffer).toString('base64');
    return {
        name,
        publisher,
        stickerPackId,
        packDescription: description,
        stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
        stickerPackSize: zipBuffer.length,
        stickers: stickerMetadata,
        fileSha256: zipUpload.fileSha256,
        fileEncSha256: zipUpload.fileEncSha256,
        mediaKey,
        directPath: zipUpload.directPath,
        fileLength: zipBuffer.length,
        mediaKeyTimestamp: unixTimestampSeconds(),
        trayIconFileName: coverFileName,
        imageDataHash,
        thumbnailDirectPath: thumbUpload.directPath,
        thumbnailSha256: thumbUpload.fileSha256,
        thumbnailEncSha256: thumbUpload.fileEncSha256,
        thumbnailHeight: 96,
        thumbnailWidth: 96
    };
};
const prepareNativeFlowButtons = (message) => {
    const buttons = message.nativeFlow;
    const isButtonsFieldArray = Array.isArray(buttons);
    const correctedField = isButtonsFieldArray ? buttons : buttons.buttons;
    const messageParamsJson = {};
    if (hasOptionalProperty(message, 'offerText') && !!message.offerText) {
        Object.assign(messageParamsJson, {
            limited_time_offer: {
                text: message.offerText || LIBRARY_NAME,
                url: message.offerUrl || DEFAULT_URL,
                copy_code: message.offerCode,
                expiration_time: message.offerExpiration
            }
        });
    }
    if (hasOptionalProperty(message, 'optionText') && !!message.optionText) {
        Object.assign(messageParamsJson, {
            bottom_sheet: {
                in_thread_buttons_limit: 1,
                divider_indices: Array.from({ length: correctedField.length }, (_, index) => index),
                list_title: message.optionTitle || '📄 Select Options',
                button_title: message.optionText
            }
        });
    }
    return {
        buttons: correctedField.map(button => {
            const buttonText = button.text || button.buttonText;
            const buttonIcon = button.icon?.toUpperCase();
            if (hasOptionalProperty(button, 'id') && !!button.id) {
                return {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '👉🏻 Click',
                        id: button.id,
                        icon: buttonIcon
                    })
                };
            }
            else if (hasOptionalProperty(button, 'copy') && !!button.copy) {
                return {
                    name: 'cta_copy',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '📋 Copy',
                        copy_code: button.copy,
                        icon: buttonIcon
                    })
                };
            }
            else if (hasOptionalProperty(button, 'url') && !!button.url) {
                return {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '🌐 Visit',
                        url: button.url,
                        merchant_url: button.url,
                        webview_interaction: button.useWebview,
                        icon: buttonIcon
                    })
                };
            }
            else if (hasOptionalProperty(button, 'call') && !!button.call) {
                return {
                    name: 'cta_call',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || '📞 Call',
                        phone_number: button.call,
                        icon: buttonIcon
                    })
                };
            }
            else if (hasOptionalProperty(button, 'sections') && !!button.sections) {
                return {
                    name: 'single_select',
                    buttonParamsJson: JSON.stringify({
                        title: buttonText || '📋 Select',
                        sections: button.sections,
                        icon: buttonIcon
                    })
                };
            }
            return button;
        }),
        messageParamsJson: JSON.stringify(messageParamsJson)
    };
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
    return ensureMessageProto(content);
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
    return message != null &&
        typeof message === 'object' &&
        key in message &&
        message[key] != null;
};
export const hasOptionalProperty = (obj, key) => {
    return obj != null &&
        typeof obj === 'object' &&
        key in obj &&
        obj[key] != null;
};
export const hasValidAlbumMedia = (message) => {
    return !!(message.imageMessage ||
        message.videoMessage);
};
export const hasValidInteractiveHeader = (message) => {
    return !!(message.imageMessage ||
        message.videoMessage ||
        message.documentMessage ||
        message.productMessage ||
        message.locationMessage);
};
export const hasValidCarouselHeader = (message) => {
    return !!(message.imageMessage ||
        message.videoMessage ||
        message.productMessage);
};
export const markViewOnce = (m) => {
    const type = getContentType(m);
    if (!type)
        return;
    const content = m[type];
    if (!content || typeof content !== 'object')
        return;
    const MessageType = WAProto.Message[type.charAt(0).toUpperCase() + type.slice(1)];
    if (!MessageType?.prototype || !('viewOnce' in MessageType.prototype))
        return;
    content.viewOnce = true;
};
export const generateWAMessageContent = async (message, options) => {
    var _a, _b;
    let m = {};
    if (hasNonNullishProperty(message, 'raw')) {
        delete message.raw;
        return message;
    }
    else if (hasNonNullishProperty(message, 'code') ||
        hasNonNullishProperty(message, 'links') ||
        hasNonNullishProperty(message, 'table') ||
        hasNonNullishProperty(message, 'richResponse')) {
        m = prepareRichResponseMessage(message);
    }
    else if (hasNonNullishProperty(message, 'text')) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (urlInfo == null) {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = urlInfo.previewType ?? urlInfo['preview-type'] ?? 0;
            extContent.linkPreviewMetadata = urlInfo.linkPreviewMetadata;
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
        const customFavicon = message.favicon;
        const favicon = customFavicon && typeof options.upload === 'function'
            ? (await prepareWAMessageMedia({ image: customFavicon }, options)).imageMessage
            : urlInfo?.favicon;
        if (favicon) {
            extContent.faviconMmsMetadata = {
                thumbnailDirectPath: favicon.directPath,
                mediaKey: favicon.mediaKey,
                mediaKeyTimestamp: favicon.mediaKeyTimestamp,
                thumbnailWidth: 32,
                thumbnailHeight: 32,
                thumbnailSha256: favicon.fileSha256,
                thumbnailEncSha256: favicon.fileEncSha256
            };
        }
        if (options.backgroundColor) {
            extContent.backgroundArgb = assertColor(options.backgroundColor);
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
            m.contactMessage = message.contacts.contacts[0];
        }
        else {
            m.contactsArrayMessage = message.contacts;
        }
    }
    else if (hasNonNullishProperty(message, 'location')) {
        m.locationMessage = message.location;
    }
    else if (hasNonNullishProperty(message, 'react')) {
        if (!message.react.senderTimestampMs) {
            message.react.senderTimestampMs = Date.now();
        }
        m.reactionMessage = message.react;
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
        m.pinInChatMessage.key = message.pin;
        m.pinInChatMessage.type = message.type;
        m.pinInChatMessage.senderTimestampMs = Date.now();
        m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0;
    }
    else if (hasNonNullishProperty(message, 'keep')) {
        m.keepInChatMessage = {};
        m.keepInChatMessage.key = message.keep;
        m.keepInChatMessage.keepType = message.type;
        m.keepInChatMessage.timestampMs = Date.now();
    }
    else if (hasNonNullishProperty(message, 'flowReply')) {
        m.interactiveResponseMessage = {
            body: {
                format: message.flowReply.format || proto.Message.InteractiveResponseMessage.Body.Format.DEFAULT,
                text: message.flowReply.text
            },
            nativeFlowResponseMessage: {
                name: message.flowReply.name,
                paramsJson: message.flowReply.paramsJson || '{}',
                version: message.flowReply.version || 1
            }
        };
    }
    else if (hasNonNullishProperty(message, 'buttonReply')) {
        switch (message.type) {
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
        }
    }
    else if (hasNonNullishProperty(message, 'listReply')) {
        m.listResponseMessage = {
            description: message.listReply.description,
            listType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT,
            singleSelectReply: {
                selectedRowId: message.listReply.id
            },
            title: message.listReply.title
        };
    }
    else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
        m.ptvMessage = videoMessage;
    }
    else if (hasNonNullishProperty(message, 'product')) {
        m.productMessage = await prepareProductMessage(message, options);
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
        const pollCreationMessage = {
            name: message.poll.name,
            selectableOptionsCount: message.poll.selectableCount,
            options: message.poll.values.map(optionName => ({ optionName })),
            endTime: message.poll.endDate ? message.poll.endDate.getTime() : undefined,
            hideParticipantName: message.poll.hideVoter ?? false,
            allowAddOption: message.poll.canAddOption ?? false
        };
        if (message.poll.toAnnouncementGroup) {
            m.pollCreationMessageV2 = pollCreationMessage;
        }
        else {
            if (message.poll.pollType === 1) {
                if (!message.poll.correctAnswer) {
                    throw new Boom('No "correctAnswer" provided for quiz', { statusCode: 400 });
                }
                m.pollCreationMessageV5 = {
                    ...pollCreationMessage,
                    correctAnswer: {
                        optionName: message.poll.correctAnswer.toString()
                    },
                    pollType: 1,
                    selectableOptionsCount: 1
                };
            }
            else if (message.poll.selectableCount === 1) {
                m.pollCreationMessageV3 = pollCreationMessage;
            }
            else {
                m.pollCreationMessage = pollCreationMessage;
            }
        }
        m.messageContextInfo = {
            messageSecret: message.poll.messageSecret || randomBytes(32)
        };
    }
    else if (hasNonNullishProperty(message, 'pollResult')) {
        const pollResultSnapshotMessage = {
            name: message.pollResult.name,
            pollVotes: message.pollResult.votes.map(vote => ({
                optionName: vote.name,
                optionVoteCount: parseInt(vote.voteCount)
            }))
        };
        if (message.pollResult.pollType === 1) {
            pollResultSnapshotMessage.pollType = proto.Message.PollType.QUIZ;
            m.pollResultSnapshotMessageV3 = pollResultSnapshotMessage;
        }
        else {
            pollResultSnapshotMessage.pollType = proto.Message.PollType.POLL;
            m.pollResultSnapshotMessage = pollResultSnapshotMessage;
        }
    }
    else if (hasNonNullishProperty(message, 'pollUpdate')) {
        if (!message.pollUpdate.key) {
            throw new Boom('Message key is required', { statusCode: 400 });
        }
        if (!message.pollUpdate.vote) {
            throw new Boom('Encrypted vote payload is required', { statusCode: 400 });
        }
        m.pollUpdateMessage = {
            metadata: message.pollUpdate.metadata,
            pollCreationMessageKey: message.pollUpdate.key,
            senderTimestampMs: Date.now(),
            vote: message.pollUpdate.vote
        };
    }
    else if (hasNonNullishProperty(message, 'paymentInviteServiceType')) {
        m.paymentInviteMessage = {
            expiryTimestamp: Date.now(),
            serviceType: message.paymentInviteServiceType
        };
    }
    else if (hasNonNullishProperty(message, 'orderText')) {
        if (!Buffer.isBuffer(message.thumbnail)) {
            throw new Boom('Must provide thumbnail buffer in order message', { statusCode: 400 });
        }
        m.orderMessage = {
            itemCount: 1,
            messageVersion: 1,
            orderTitle: LIBRARY_NAME,
            status: proto.Message.OrderMessage.OrderStatus.INQUIRY,
            surface: proto.Message.OrderMessage.OrderSurface.CATALOG,
            token: generateMessageIDV2(),
            totalAmount1000: 1000,
            totalCurrencyCode: 'IDR',
            ...message,
            message: message.orderText
        };
        delete m.orderMessage.orderText;
    }
    else if (hasNonNullishProperty(message, 'album')) {
        if (!Array.isArray(message.album)) {
            throw new Boom('Invalid album type. Expected an array.', { statusCode: 400 });
        }
        let videoCount = 0;
        for (let i = 0; i < message.album.length; i++) {
            if (message.album[i].video)
                videoCount++;
        }
        ;
        let imageCount = 0;
        for (let i = 0; i < message.album.length; i++) {
            if (message.album[i].image)
                imageCount++;
        }
        ;
        if ((videoCount + imageCount) < 2) {
            throw new Boom('Minimum provide 2 media to upload album message', { statusCode: 400 });
        }
        m.albumMessage = {
            expectedImageCount: imageCount,
            expectedVideoCount: videoCount
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
    else if (hasNonNullishProperty(message, 'stickers') || hasNonNullishProperty(message, 'stickerPack')) {
        m.stickerPackMessage = await generateStickerPackMessage(message.stickerPack || message, options);
    }
    else {
        m = await prepareWAMessageMedia(message, options);
    }
    if (hasNonNullishProperty(message, 'buttons')) {
        const buttonsMessage = {
            buttons: message.buttons.map(button => {
                const buttonText = button.text || button.buttonText;
                if (hasOptionalProperty(button, 'sections')) {
                    return {
                        nativeFlowInfo: {
                            name: 'single_select',
                            paramsJson: JSON.stringify({
                                title: buttonText,
                                sections: button.sections
                            })
                        },
                        type: ButtonType.NATIVE_FLOW
                    };
                }
                else if (hasOptionalProperty(button, 'name')) {
                    return {
                        nativeFlowInfo: {
                            name: button.name,
                            paramsJson: button.paramsJson
                        },
                        type: ButtonType.NATIVE_FLOW
                    };
                }
                return {
                    buttonId: button.id || button.buttonId,
                    buttonText: typeof buttonText === 'string' ? { displayText: buttonText } : buttonText,
                    type: button.type || ButtonType.RESPONSE
                };
            })
        };
        if (hasOptionalProperty(message, 'text')) {
            buttonsMessage.contentText = message.text;
            buttonsMessage.headerType = ButtonHeaderType.EMPTY;
        }
        else {
            if (hasOptionalProperty(message, 'caption')) {
                buttonsMessage.contentText = message.caption;
            }
            const type = Object.keys(m)[0].replace('Message', '').toUpperCase();
            buttonsMessage.headerType = ButtonHeaderType[type];
            Object.assign(buttonsMessage, m);
        }
        if (hasOptionalProperty(message, 'footer')) {
            buttonsMessage.footerText = message.footer;
        }
        m = { buttonsMessage };
    }
    else if (hasNonNullishProperty(message, 'sections')) {
        const listMessage = {
            sections: message.sections,
            buttonText: message.buttonText,
            title: message.title,
            footerText: message.footer,
            description: message.text,
            listType: ListType.SINGLE_SELECT
        };
        m = { listMessage };
    }
    else if (hasNonNullishProperty(message, 'templateButtons')) {
        const hydratedTemplate = {
            hydratedButtons: message.templateButtons.map((button, i) => {
                const buttonText = button.text || button.buttonText;
                if (hasOptionalProperty(button, 'id')) {
                    return {
                        index: i,
                        quickReplyButton: {
                            displayText: buttonText || '👉🏻 Click',
                            id: button.id
                        }
                    };
                }
                else if (hasOptionalProperty(button, 'url')) {
                    return {
                        index: i,
                        urlButton: {
                            displayText: buttonText || '🌐 Visit',
                            url: button.url
                        }
                    };
                }
                else if (hasOptionalProperty(button, 'call')) {
                    return {
                        index: i,
                        callButton: {
                            displayText: buttonText || '📞 Call',
                            phoneNumber: button.call
                        }
                    };
                }
                button.index = button.index || i;
                return button;
            })
        };
        if (hasOptionalProperty(message, 'text')) {
            hydratedTemplate.hydratedContentText = message.text;
        }
        else {
            if (hasOptionalProperty(message, 'caption')) {
                hydratedTemplate.hydratedTitleText = message.title;
                hydratedTemplate.hydratedContentText = message.caption;
            }
            ;
            Object.assign(hydratedTemplate, m);
        }
        if (hasOptionalProperty(message, 'footer')) {
            hydratedTemplate.hydratedFooterText = message.footer;
        }
        hydratedTemplate.templateId = message.id || 'template-' + Date.now();
        m = {
            templateMessage: {
                hydratedFourRowTemplate: hydratedTemplate,
                hydratedTemplate: hydratedTemplate
            }
        };
    }
    else if (hasNonNullishProperty(message, 'nativeFlow')) {
        const interactiveMessage = {
            nativeFlowMessage: prepareNativeFlowButtons(message)
        };
        if (hasOptionalProperty(message, 'bizJid')) {
            interactiveMessage.collectionMessage = {
                bizJid: message.bizJid,
                id: message.id,
                messageVersion: 1
            };
        }
        else if (hasOptionalProperty(message, 'shopSurface')) {
            interactiveMessage.shopStorefrontMessage = {
                surface: message.shopSurface,
                id: message.id,
                messageVersion: 1
            };
        }
        if (hasOptionalProperty(message, 'text')) {
            interactiveMessage.body = { text: message.text };
        }
        else {
            if (hasOptionalProperty(message, 'caption')) {
                const isValidHeader = hasValidInteractiveHeader(m);
                if (!isValidHeader) {
                    throw new Boom('Invalid media type for interactive message header', { statusCode: 400 });
                }
                interactiveMessage.header = {
                    title: message.title || '',
                    subtitle: message.subtitle || '',
                    hasMediaAttachment: isValidHeader
                };
                interactiveMessage.body = { text: message.caption };
            }
            if (hasOptionalProperty(message, 'thumbnail') && !!message.thumbnail) {
                interactiveMessage.jpegThumbnail = message.thumbnail;
            }
            Object.assign(interactiveMessage.header, m);
        }
        if (hasOptionalProperty(message, 'audioFooter')) {
            const { audioMessage } = await prepareWAMessageMedia({
                audio: message.audioFooter
            }, options);
            interactiveMessage.footer = {
                audioMessage,
                hasMediaAttachment: true
            };
        }
        else if (hasOptionalProperty(message, 'footer')) {
            interactiveMessage.footer = { text: message.footer };
        }
        m = { interactiveMessage };
    }
    else if (hasNonNullishProperty(message, 'cards')) {
        const interactiveMessage = {
            carouselMessage: {
                cards: await Promise.all(message.cards.map(async (card) => {
                    let carouselHeader = {};
                    if (hasNonNullishProperty(card, 'product')) {
                        carouselHeader.productMessage = await prepareProductMessage(card, options);
                    }
                    else {
                        carouselHeader = await prepareWAMessageMedia(card, options).catch(() => ({}));
                    }
                    const isValidHeader = hasValidCarouselHeader(carouselHeader);
                    if (!isValidHeader) {
                        throw new Boom('Invalid media type for carousel card', { statusCode: 400 });
                    }
                    const carouselCard = {
                        nativeFlowMessage: prepareNativeFlowButtons(card.nativeFlow ? card : [])
                    };
                    if (hasOptionalProperty(card, 'text')) {
                        carouselCard.body = { text: card.text };
                    }
                    else {
                        if (hasOptionalProperty(card, 'caption')) {
                            carouselCard.header = {
                                title: card.title || '',
                                subtitle: card.subtitle || '',
                                hasMediaAttachment: isValidHeader
                            };
                            carouselCard.body = { text: card.caption };
                        }
                        if (hasOptionalProperty(card, 'thumbnail') && !!card.thumbnail) {
                            carouselCard.jpegThumbnail = card.thumbnail;
                        }
                        Object.assign(carouselCard.header, carouselHeader);
                    }
                    if (hasOptionalProperty(card, 'audioFooter')) {
                        const { audioMessage } = await prepareWAMessageMedia({
                            audio: card.audioFooter
                        }, options);
                        carouselCard.footer = {
                            audioMessage,
                            hasMediaAttachment: true
                        };
                    }
                    else if (hasOptionalProperty(card, 'footer')) {
                        carouselCard.footer = { text: card.footer };
                    }
                    return carouselCard;
                })),
                carouselCardType: CarouselCardType.UNKNOWN,
                messageVersion: 1
            }
        };
        if (hasOptionalProperty(message, 'text')) {
            interactiveMessage.body = { text: message.text };
        }
        if (hasOptionalProperty(message, 'footer')) {
            interactiveMessage.footer = { text: message.footer };
        }
        m = { interactiveMessage };
    }
    else if (hasNonNullishProperty(message, 'requestPaymentFrom')) {
        const requestPaymentMessage = {
            amount: {
                currencyCode: 'IDR',
                offset: 1000,
                value: 1000
            },
            amount1000: 1000,
            currencyCodeIso4217: 'IDR',
            expiryTimestamp: Date.now(),
            noteMessage: m,
            requestFrom: message.requestPaymentFrom,
            ...message
        };
        delete requestPaymentMessage.requestPaymentFrom;
        if (hasNonNullishProperty(m, 'extendedTextMessage') || hasNonNullishProperty(m, 'stickerMessage')) {
            Object.assign(requestPaymentMessage.noteMessage, m);
        }
        else {
            throw new Boom('Invalid message type for request payment note message', { statusCode: 400 });
        }
        m = { requestPaymentMessage };
    }
    else if (hasNonNullishProperty(message, 'invoiceNote')) {
        const attachment = m.imageMessage || m.documentMessage;
        const type = Object.keys(m)[0].replace('Message', '').toUpperCase();
        const invoiceMessage = {
            attachmentType: proto.Message.InvoiceMessage.AttachmentType[type === 'DOCUMENT' ? 'PDF' : 'IMAGE'],
            note: message.invoiceNote
        };
        if (attachment) {
            const { directPath, fileEncSha256, fileSha256, jpegThumbnail = undefined, mediaKey, mediaKeyTimestamp, mimetype } = attachment;
            Object.assign(invoiceMessage, {
                attachmentDirectPath: directPath,
                attachmentFileEncSha256: fileEncSha256,
                attachmentFileSha256: fileSha256,
                attachmentJpegThumbnail: jpegThumbnail,
                attachmentMediaKey: mediaKey,
                attachmentMediaKeyTimestamp: mediaKeyTimestamp,
                attachmentMimetype: mimetype,
                token: generateMessageIDV2()
            });
        }
        else {
            throw new Boom('Invalid media type for invoice message', { statusCode: 400 });
        }
        m = { invoiceMessage };
    }
    if (hasOptionalProperty(message, 'externalAdReply') && !!message.externalAdReply) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        const content = message.externalAdReply;
        if ('thumbnail' in content && !Buffer.isBuffer(content.thumbnail)) {
            throw new Boom('Thumbnail must in buffer type', { statusCode: 400 });
        }
        if (!content.url || typeof content.url !== 'string') {
            content.url = DEFAULT_URL;
        }
        const externalAdReply = {
            ...content,
            body: content.body,
            mediaType: content.mediaType || 1,
            mediaUrl: content.url,
            renderLargerThumbnail: content.largeThumbnail,
            sourceUrl: content.url,
            thumbnail: content.thumbnail,
            thumbnailUrl: content.url + '?update=' + Date.now(),
            title: content.title || LIBRARY_NAME
        };
        delete externalAdReply.subTitle;
        delete externalAdReply.largeThumbnail;
        delete externalAdReply.url;
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.externalAdReply = { ...key.contextInfo.externalAdReply, ...externalAdReply };
        }
        else if (key) {
            key.contextInfo = { externalAdReply };
        }
    }
    if ((hasOptionalProperty(message, 'mentions') && message.mentions?.length) ||
        (hasOptionalProperty(message, 'mentionAll') && message.mentionAll)) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if (key && 'contextInfo' in key) {
            key.contextInfo = key.contextInfo || {};
            if (message.mentions?.length) {
                key.contextInfo.mentionedJid = message.mentions;
            }
            if (message.mentionAll) {
                key.contextInfo.nonJidMentions = 1;
            }
        }
        else if (key) {
            key.contextInfo = {
                mentionedJid: message.mentions,
                nonJidMentions: message.mentionAll ? 1 : 0
            };
        }
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
    if (hasOptionalProperty(message, 'groupStatus') && !!message.groupStatus) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isGroupStatus = message.groupStatus;
        }
        else if (key) {
            key.contextInfo = {
                isGroupStatus: message.groupStatus
            };
        }
        m = { groupStatusMessageV2: { message: m } };
        delete message.groupStatus;
    }
    if (hasOptionalProperty(message, 'spoiler') && !!message.spoiler) {
        const messageType = Object.keys(m)[0];
        const key = m[messageType];
        if ('contextInfo' in key && !!key.contextInfo) {
            key.contextInfo.isSpoiler = message.spoiler;
        }
        else if (key) {
            key.contextInfo = {
                isSpoiler: message.spoiler
            };
        }
        m = { spoilerMessage: { message: m } };
        delete message.spoiler;
    }
    else if (hasOptionalProperty(message, 'interactiveAsTemplate') && !!message.interactiveAsTemplate) {
        if (!m.interactiveMessage) {
            throw new Boom('Invalid message type for template', { statusCode: 400 });
        }
        m = {
            templateMessage: {
                interactiveMessageTemplate: m.interactiveMessage,
                templateId: message.id || 'template-' + Date.now()
            }
        };
        delete message.interactiveAsTemplate;
    }
    if (hasOptionalProperty(message, 'ephemeral') && !!message.ephemeral) {
        m = { ephemeralMessage: { message: m } };
        delete message.ephemeral;
    }
    if (hasOptionalProperty(message, 'isLottie') && !!message.isLottie) {
        m = { lottieStickerMessage: { message: m } };
    }
    else if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
        markViewOnce(m);
        m = { viewOnceMessage: { message: m } };
    }
    else if (hasOptionalProperty(message, 'viewOnceV2') && !!message.viewOnceV2) {
        markViewOnce(m);
        m = { viewOnceMessageV2: { message: m } };
        delete message.viewOnceV2;
    }
    else if (hasOptionalProperty(message, 'viewOnceV2Extension') && !!message.viewOnceV2Extension) {
        markViewOnce(m);
        m = { viewOnceMessageV2Extension: { message: m } };
        delete message.viewOnceV2Extension;
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
    if (shouldIncludeReportingToken(m)) {
        m.messageContextInfo = m.messageContextInfo || {};
        if (!m.messageContextInfo.messageSecret) {
            m.messageContextInfo.messageSecret = randomBytes(32);
        }
    }
    return ensureMessageProto(m);
};
export const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) {
        options.timestamp = new Date();
    }
    const innerMessage = normalizeMessageContent(message);
    const messageContextInfo = message.messageContextInfo;
    const key = getContentType(innerMessage);
    const timestamp = unixTimestampSeconds(options.timestamp);
    const isNewsletter = isJidNewsletter(jid);
    const { quoted, userJid } = options;
    if (quoted) {
        const participant = quoted.key.fromMe
            ? userJid
            : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
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
        if (!isNewsletter && jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid;
        }
        if (contextInfo && innerMessage[key]) {
            innerMessage[key].contextInfo = contextInfo;
        }
    }
    if (
    !!options?.ephemeralExpiration &&
        key !== 'protocolMessage' &&
        key !== 'ephemeralMessage' &&
        !isNewsletter) {
        innerMessage[key].contextInfo = {
            ...(innerMessage[key].contextInfo || {}),
            expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL
        };
    }
    if (messageContextInfo?.messageSecret && (isPnUser(jid) || isLidUser(jid))) {
        messageContextInfo.deviceListMetadata = {
            recipientKeyHash: randomBytes(10),
            recipientTimestamp: unixTimestampSeconds()
        };
        messageContextInfo.deviceListMetadataVersion = 2;
    }
    return WAProto.WebMessageInfo.create({
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generateMessageIDV2()
        },
        message: ensureMessageProto(message),
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined,
        status: WAMessageStatus.PENDING
    });
};
export const generateWAMessage = async (jid, content, options) => {
    options.logger = options?.logger?.child({ msgId: options.messageId });
    if (jid) {
        options.jid = jid;
    }
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, options), options);
};
export const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content);
        const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
        return key;
    }
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
        return (message?.acp2SettingMessage ||
            message?.associatedChildMessage ||
            message?.audioStickerMessage ||
            message?.botForwardedMessage ||
            message?.botGroupParticipantMessage ||
            message?.botInvokeMessage ||
            message?.botPlatformRegistrationSuccessMessage ||
            message?.botTaskMessage ||
            message?.documentWithCaptionMessage ||
            message?.editedMessage ||
            message?.ephemeralMessage ||
            message?.eventCoverImage ||
            message?.groupMentionedMessage ||
            message?.groupStatusMentionMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2 ||
            message?.limitSharingMessage ||
            message?.lottieStickerMessage ||
            message?.newsletterAdminProfileMessage ||
            message?.newsletterAdminProfileMessageV2 ||
            message?.newsletterAdminProfileStatusMessage ||
            message?.newsletterScheduledMessage ||
            message?.pollCreationMessageV4 ||
            message?.pollCreationOptionImageMessage ||
            message?.questionMessage ||
            message?.questionReplyMessage ||
            message?.spoilerMessage ||
            message?.statusAddYours ||
            message?.statusMentionMessage ||
            message?.viewOnceMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension);
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
            typeof error?.status === 'number' &&
            REUPLOAD_REQUIRED_STATUS.includes(error?.output?.statusCode ?? error?.status)) {
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
        let mediaType = contentType?.replace('Message', '');
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
const isAnimatedWebP = (buffer) => {
    if (buffer.length < 12 ||
        buffer[0] !== 0x52 ||
        buffer[1] !== 0x49 ||
        buffer[2] !== 0x46 ||
        buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 ||
        buffer[9] !== 0x45 ||
        buffer[10] !== 0x42 ||
        buffer[11] !== 0x50) {
        return false;
    }
    ;
    let offset = 12;
    while (offset < buffer.length - 8) {
        const chunkFourCC = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        if (chunkFourCC === 'VP8X') {
            const flagsOffset = offset + 8;
            if (flagsOffset < buffer.length) {
                const flags = buffer[flagsOffset];
                if (flags & 0x02) {
                    return true;
                }
                ;
            }
            ;
        }
        else if (chunkFourCC === 'ANIM' || chunkFourCC === 'ANMF') {
            return true;
        }
        ;
        offset += 8 + chunkSize + (chunkSize % 2);
    }
    ;
    return false;
};
const isWebPBuffer = (buffer) => {
    return (buffer.length >= 12 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50);
};
export const shouldIncludeBizBinaryNode = (message) => !!(message.buttonsMessage ||
    message.listMessage ||
    message.templateMessage ||
    (message.interactiveMessage &&
        message.interactiveMessage.nativeFlowMessage));
export const isViewOnceMessage = (message) => {
    if (message?.viewOnce === true ||
        message?.viewOnceMessage ||
        message?.viewOnceMessageV2 ||
        message?.viewOnceMessageV2Extension)
        return true;
    const innerMsg = normalizeMessageContent(message);
    const msgType = getContentType(innerMsg);
    const msgCtn = innerMsg?.[msgType];
    return msgCtn?.viewOnce === true;
};
