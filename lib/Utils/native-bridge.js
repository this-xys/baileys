import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require2 = createRequire(import.meta.url);
const BRIDGE_NAME = "whatsapp-rust-bridge";
let cached;
let attempted = false;

const findPackageDir = (pkgName) => {
  let searchPaths;
  try {
    searchPaths = require2.resolve.paths(pkgName) || [];
  } catch {
    searchPaths = [];
  }
  for (const dir of searchPaths) {
    const candidate = path.join(dir, pkgName);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return null;
};

const loadRustBridge = () => {
  if (attempted) return cached;
  attempted = true;
  try {
    cached = require2(BRIDGE_NAME);
    return cached;
  } catch (error) {
    const recoverableCodes = /* @__PURE__ */ new Set(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_IMPORT_NOT_DEFINED"]);
    if (!recoverableCodes.has(error?.code)) {
      cached = null;
      return null;
    }
    try {
      const dir = findPackageDir(BRIDGE_NAME);
      if (!dir) {
        cached = null;
        return null;
      }
      const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
      const candidates = [pkgJson.main, "index.js", "index.node", "dist/index.js", "lib/index.js", "build/index.js"].filter(Boolean);
      for (const rel of candidates) {
        const fullPath = path.join(dir, rel);
        if (fs.existsSync(fullPath)) {
          cached = require2(fullPath);
          return cached;
        }
      }
    } catch {
    }
    cached = null;
    return null;
  }
};

export {
  loadRustBridge
};
