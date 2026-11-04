import { getLinkPreview } from '../Addon/index.js';
import { prepareWAMessageMedia } from './messages.js';
import { extractImageThumb, getHttpStream } from './messages-media.js';
const URL_PROTOCOL_REGEX = /^https?:\/\//;
const THUMBNAIL_WIDTH_PX = 192;
const getCompressedJpegThumbnail = async (url, { thumbnailWidth, fetchOpts }) => {
    const stream = await getHttpStream(url, fetchOpts);
    const result = await extractImageThumb(stream, thumbnailWidth);
    return result;
};
export const getUrlInfo = async (text, opts = {
    thumbnailWidth: THUMBNAIL_WIDTH_PX,
    fetchOpts: { timeout: 3000 }
}) => {
    try {
        const previewLink = URL_PROTOCOL_REGEX.test(text) ? text : 'https://' + text;
        const result = await getLinkPreview(previewLink, {
            timeout: opts.fetchOpts.timeout,
            headers: opts.fetchOpts.headers
        });
        const info = result && {
            url: result.url,
            title: result.title,
            description: result.description,
            image: result.images?.[0],
            favicon: result.favicons?.[0],
            video: result.videos?.[0]
        };
        if (info?.title) {
            const urlInfo = {
                'canonical-url': info.url,
                'matched-text': text,
                title: info.title,
                description: info.description,
                originalThumbnailUrl: info.image,
                'preview-type': info.video ? 1 : 0
            };
            if (opts.uploadImage) {
                await Promise.all([
                    info.image
                        ? (async () => {
                            const { imageMessage } = await prepareWAMessageMedia({ image: { url: info.image } }, {
                                upload: opts.uploadImage,
                                mediaTypeOverride: 'thumbnail-link',
                                options: opts.fetchOpts
                            });
                            urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined;
                            urlInfo.highQualityThumbnail = imageMessage;
                        })()
                        : Promise.resolve(),
                    info.favicon
                        ? (async () => {
                            const { imageMessage } = await prepareWAMessageMedia({ image: { url: info.favicon } }, {
                                upload: opts.uploadImage,
                                mediaTypeOverride: 'thumbnail-link',
                                options: opts.fetchOpts
                            });
                            urlInfo.favicon = imageMessage;
                        })()
                        : Promise.resolve()
                ]);
            }
            else {
                try {
                    urlInfo.jpegThumbnail = info.image ? (await getCompressedJpegThumbnail(info.image, opts)).buffer : undefined;
                }
                catch (error) {
                    opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail');
                }
            }
            return urlInfo;
        }
    }
    catch (error) {
        if (!error.message.includes('receive a valid')) {
            throw error;
        }
    }
};
