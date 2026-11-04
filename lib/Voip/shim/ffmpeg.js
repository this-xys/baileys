import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveFfmpegPath } from '../../Utils/ffmpeg-path.js';

let cachedProbe;

export async function resolveFfmpegBin() {
    try {
        return (await resolveFfmpegPath()) || 'ffmpeg';
    }
    catch {
        return 'ffmpeg';
    }
}

async function modulePath(name, pick) {
    try {
        const mod = await import(name);
        const p = pick(mod?.default ?? mod);
        if (typeof p === 'string' && existsSync(p))
            return p;
    }
    catch { }
    return null;
}

export async function resolveFfprobeBin(explicit) {
    if (explicit)
        return explicit;
    if (process.env.FFPROBE_PATH && existsSync(process.env.FFPROBE_PATH))
        return process.env.FFPROBE_PATH;
    if (cachedProbe)
        return cachedProbe;
    let found = (await modulePath('ffprobe-static', (m) => m?.path)) ||
        (await modulePath('@ffprobe-installer/ffprobe', (m) => m?.path));
    if (!found) {
        const ffmpeg = await resolveFfmpegBin();
        if (ffmpeg && ffmpeg !== 'ffmpeg') {
            const sibling = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
            if (existsSync(sibling))
                found = sibling;
        }
    }
    cachedProbe = found || 'ffprobe';
    return cachedProbe;
}
