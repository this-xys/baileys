import { platform } from 'os';
import { proto } from '../../WAProto/index.js';
export const PLATFORM_MAP = {
    'aix':'AIX','darwin':'Mac OS','win32':'Windows','android':'Android',
    'freebsd':'FreeBSD','openbsd':'OpenBSD','sunos':'Solaris','linux':'Linux',
    'ubuntu':'Ubuntu','ios':'iOS','baileys':'Baileys','chromeos':'Chrome OS',
    'tizen':'Tizen','watchos':'watchOS','wearos':'Wear OS','harmonyos':'HarmonyOS',
    'kaios':'KaiOS','smarttv':'Smart TV','raspberrypi':'Raspberry Pi OS',
    'symbian':'Symbian','blackberry':'Blackberry OS','windowsphone':'Windows Phone'
};
export const PLATFORM_VERSIONS = {
    'ubuntu':'22.04.4','darwin':'18.5','win32':'10.0.22631','android':'14.0.0',
    'freebsd':'13.2','openbsd':'7.3','sunos':'11','linux':'6.5','ios':'18.2',
    'baileys':'6.5.0','chromeos':'117.0.5938.132','tizen':'6.5','watchos':'10.1',
    'wearos':'4.1','harmonyos':'4.0.0','kaios':'3.1','smarttv':'23.3.1',
    'raspberrypi':'11 (Bullseye)','symbian':'3','blackberry':'10.3.3','windowsphone':'8.1'
};
export const Browsers = {
    ubuntu: (browser) => [PLATFORM_MAP['ubuntu'], browser, PLATFORM_VERSIONS['ubuntu']],
    macOS: (browser) => [PLATFORM_MAP['darwin'], browser, PLATFORM_VERSIONS['darwin']],
    windows: (browser) => [PLATFORM_MAP['win32'], browser, PLATFORM_VERSIONS['win32']],
    linux: (browser) => [PLATFORM_MAP['linux'], browser, PLATFORM_VERSIONS['linux']],
    solaris: (browser) => [PLATFORM_MAP['sunos'], browser, PLATFORM_VERSIONS['sunos']],
    baileys: (browser) => [PLATFORM_MAP['baileys'], browser, PLATFORM_VERSIONS['baileys']],
    android: (browser) => [PLATFORM_MAP['android'], browser, PLATFORM_VERSIONS['android']],
    iOS: (browser) => [PLATFORM_MAP['ios'], browser, PLATFORM_VERSIONS['ios']],
    kaiOS: (browser) => [PLATFORM_MAP['kaios'], browser, PLATFORM_VERSIONS['kaios']],
    chromeOS: (browser) => [PLATFORM_MAP['chromeos'], browser, PLATFORM_VERSIONS['chromeos']],
    appropriate: (browser) => {
        const p = platform();
        return [PLATFORM_MAP[p] || 'Unknown OS', browser, PLATFORM_VERSIONS[p] || 'latest'];
    },
    custom: (p, browser, version) => {
        return [PLATFORM_MAP[p.toLowerCase()] || p, browser, version || PLATFORM_VERSIONS[p] || 'latest'];
    }
};
export const getPlatformId = (browser) => {
    const platformType = proto.DeviceProps.PlatformType[browser.toUpperCase()];
    return platformType ? platformType.toString() : '1';
};