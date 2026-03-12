function _nl(jid) {
    return jid.endsWith('@newsletter') ? jid : `${jid}@newsletter`;
}

export function makeNewsletterUtils(conn) {
    async function _send(jid, content, options = {}) {
        return conn.sendMessage(_nl(jid), content, options);
    }
    async function sendNewsletterText(jid, text, options = {}) {
        return _send(jid, { text }, options);
    }
    async function sendNewsletterImage(jid, image, options = {}) {
        return _send(jid, { image, caption: options.caption, mimetype: options.mimetype, jpegThumbnail: options.jpegThumbnail }, options);
    }
    async function sendNewsletterVideo(jid, video, options = {}) {
        return _send(jid, { video, caption: options.caption, mimetype: options.mimetype, gifPlayback: options.gifPlayback }, options);
    }
    async function sendNewsletterPtv(jid, video, options = {}) {
        return _send(jid, { video, ptv: true, mimetype: options.mimetype || 'video/mp4' }, options);
    }
    async function sendNewsletterAudio(jid, audio, options = {}) {
        return _send(jid, { audio, mimetype: options.mimetype, seconds: options.seconds, ptt: options.ptt }, options);
    }
    async function sendNewsletterDocument(jid, document, options = {}) {
        return _send(jid, {
            document,
            mimetype: options.mimetype || 'application/octet-stream',
            fileName: options.fileName || 'file',
            caption: options.caption
        }, options);
    }
    async function sendNewsletterSticker(jid, sticker, options = {}) {
        return _send(jid, { sticker, isAnimated: options.isAnimated }, options);
    }
    async function sendNewsletterButtons(jid, params, options = {}) {
        const { body, buttons = [], title, footer } = params;
        const nativeButtons = buttons.map(b => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: b.text || b.displayText || '',
                id: b.id || b.text || ''
            })
        }));
        const interactiveMessage = {
            nativeFlowMessage: {
                buttons: nativeButtons,
                messageParamsJson: '',
                messageVersion: 1
            },
            body: { text: body || '' },
            ...(footer ? { footer: { text: footer } } : {}),
            ...(title ? { header: { title, hasMediaAttachment: false, subtitle: '' } } : {})
        };
        return _send(jid, { interactiveMessage }, options);
    }
    async function sendNewsletterList(jid, params, options = {}) {
        const { body, buttonText, sections = [], title, footer } = params;
        const interactiveMessage = {
            nativeFlowMessage: {
                buttons: [{
                    name: 'single_select',
                    buttonParamsJson: JSON.stringify({
                        title: buttonText || 'Select',
                        sections: sections.map(sec => ({
                            title: sec.title || '',
                            highlight_label: '',
                            rows: (sec.rows || []).map(row => ({
                                header: '',
                                title: row.title || '',
                                description: row.description || '',
                                id: row.id || row.rowId || row.title || ''
                            }))
                        }))
                    })
                }],
                messageParamsJson: '',
                messageVersion: 1
            },
            body: { text: body || '' },
            ...(footer ? { footer: { text: footer } } : {}),
            ...(title ? { header: { title, hasMediaAttachment: false, subtitle: '' } } : {})
        };
        return _send(jid, { interactiveMessage }, options);
    }
    async function sendNewsletterCtaUrl(jid, params, options = {}) {
        const { body, buttonText, url, title, footer } = params;
        const interactiveMessage = {
            nativeFlowMessage: {
                buttons: [{
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: buttonText || 'Open',
                        url: url || '',
                        merchant_url: url || ''
                    })
                }],
                messageParamsJson: '',
                messageVersion: 1
            },
            body: { text: body || '' },
            ...(footer ? { footer: { text: footer } } : {}),
            ...(title ? { header: { title, hasMediaAttachment: false, subtitle: '' } } : {})
        };
        return _send(jid, { interactiveMessage }, options);
    }
    async function sendNewsletterReact(jid, serverId, emoji) {
        return conn.newsletterReactMessage(_nl(jid), serverId, emoji);
    }
    async function editNewsletterMessage(jid, messageId, newText) {
        return _send(jid, {
            text: newText,
            edit: { remoteJid: _nl(jid), fromMe: true, id: messageId }
        });
    }
    async function deleteNewsletterMessage(jid, messageId) {
        return _send(jid, {
            delete: { remoteJid: _nl(jid), fromMe: true, id: messageId }
        });
    }

    return {
        sendNewsletterText,
        sendNewsletterImage,
        sendNewsletterVideo,
        sendNewsletterPtv,
        sendNewsletterAudio,
        sendNewsletterDocument,
        sendNewsletterSticker,
        sendNewsletterButtons,
        sendNewsletterList,
        sendNewsletterCtaUrl,
        sendNewsletterReact,
        editNewsletterMessage,
        deleteNewsletterMessage,
    };
}