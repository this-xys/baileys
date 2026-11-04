import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

let overridePath = null;
let cached;

const moduleProvidedPath = async () => {
  try {
    const mod = await import("ffmpeg-static");
    const p = mod?.default ?? mod;
    if (typeof p === "string" && existsSync(p)) {
      return p;
    }
  } catch {}
  try {
    const mod = await import("@ffmpeg-installer/ffmpeg");
    const p = (mod?.default ?? mod)?.path;
    if (typeof p === "string" && existsSync(p)) {
      return p;
    }
  } catch {}
  return null;
};

const systemHasFfmpeg = () => {
  try {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
};

export const setFfmpegPath = (path) => {
  overridePath = path || null;
  cached = void 0;
};

export const resolveFfmpegPath = async () => {
  if (overridePath) {
    return overridePath;
  }
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  if (cached !== void 0) {
    return cached;
  }
  cached = (await moduleProvidedPath()) ?? (systemHasFfmpeg() ? "ffmpeg" : null);
  return cached;
};

export const requireFfmpegPath = async () => {
  const path = await resolveFfmpegPath();
  if (path) {
    return path;
  }
  throw new Error(ffmpegInstallHint());
};

export const ffmpegInstallHint = () => {
  const lines = ["ffmpeg not found. Install one of:"];
  const isAndroid = process.platform === "android" || !!process.env.TERMUX_VERSION || existsSync("/data/data/com.termux");
  if (isAndroid) {
    lines.push("  - Termux:  pkg install ffmpeg   (recommended -- npm ffmpeg bundles have no Android binary)");
  } else if (process.platform === "linux") {
    lines.push("  - npm:     npm i ffmpeg-static   (auto-detected, no config needed)");
    lines.push("  - Debian/Ubuntu:  sudo apt install ffmpeg");
  } else if (process.platform === "darwin") {
    lines.push("  - npm:     npm i ffmpeg-static   (auto-detected, no config needed)");
    lines.push("  - Homebrew:  brew install ffmpeg");
  } else if (process.platform === "win32") {
    lines.push("  - npm:     npm i ffmpeg-static   (auto-detected, no config needed)");
    lines.push("  - winget:  winget install ffmpeg   (or choco/scoop install ffmpeg)");
  } else {
    lines.push("  - npm:     npm i ffmpeg-static");
    lines.push("  - or your system package manager");
  }
  lines.push("  - or pin a binary yourself: setFfmpegPath('/path/to/ffmpeg') / FFMPEG_PATH env var");
  return lines.join("\n");
};

export const _resetFfmpegCache = () => {
  cached = void 0;
  overridePath = null;
};
