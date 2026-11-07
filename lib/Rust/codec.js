import { bridge, rust } from './bridge.js';

const isBytes = (v) => v instanceof Uint8Array;

const toBridgeNode = (node) => {
    if (!node || typeof node.tag !== 'string' || !node.tag)
        return null;
    const attrs = {};
    if (node.attrs) {
        for (const key of Object.keys(node.attrs)) {
            const value = node.attrs[key];
            if (value === undefined || value === null)
                continue;
            if (typeof value !== 'string' || value.trim() === '')
                return null;
            attrs[key] = value;
        }
    }
    const out = { tag: node.tag, attrs };
    const { content } = node;
    if (content === undefined)
        return out;
    if (typeof content === 'string') {
        if (content === '')
            return null;
        out.content = content;
        return out;
    }
    if (isBytes(content)) {
        out.content = content;
        return out;
    }
    if (Array.isArray(content)) {
        const children = [];
        for (const item of content) {
            if (!item || !(item.tag || isBytes(item) || typeof item === 'string'))
                continue;
            if (typeof item === 'string' || isBytes(item))
                return null;
            const child = toBridgeNode(item);
            if (!child)
                return null;
            children.push(child);
        }
        out.content = children;
        return out;
    }
    return null;
};

export const tryEncodeNode = (node) => {
    if (!rust.codec)
        return null;
    const safe = toBridgeNode(node);
    if (!safe)
        return null;
    try {
        return Buffer.from(bridge.encodeNode(safe));
    }
    catch {
        return null;
    }
};

const releaseNode = (node) => {
    try {
        node.free?.();
    }
    catch {
    }
};

export const materializeNode = (wasmNode) => {
    const content = wasmNode.content;
    const attrs = { ...wasmNode.attrs };
    let out;
    if (Array.isArray(content)) {
        out = { tag: wasmNode.tag, attrs, content: content.map(materializeNode) };
    }
    else if (isBytes(content)) {
        out = { tag: wasmNode.tag, attrs, content: Buffer.from(content) };
    }
    else {
        out = { tag: wasmNode.tag, attrs, content };
    }
    releaseNode(wasmNode);
    return out;
};

export const tryDecodeNode = (buffer) => {
    if (!rust.codec)
        return null;
    try {
        return materializeNode(bridge.decodeNode(buffer));
    }
    catch {
        return null;
    }
};
