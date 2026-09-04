import * as vscode from 'vscode';

/** Publisher-qualified extension id — must match package.json publisher + name. */
const EXTENSION_ID = 'husamettinulutas.oneprovider-maestro';

/** Used only if the extension host cannot report its own version. */
const FALLBACK_VERSION = '1.0.0';

export const ONEPROVIDER_APP_TITLE = 'OneProvider Maestro';
export const ONEPROVIDER_APP_URL = 'https://github.com/husamettinulutas/oneprovider-maestro';

/** Public OneProvider surfaces the UI links to. */
export const ONEPROVIDER_DASHBOARD_URL = 'https://dashboard.oneprovider.dev/';
export const ONEPROVIDER_DOCS_URL = 'https://oneprovider.dev/docs';
export const ONEPROVIDER_TOPUP_URL = 'https://t.me/oneprovider_robot';

/** The running extension's version, read from the manifest rather than hardcoded. */
export function getExtensionVersion(): string {
  try {
    const version = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version;
    return typeof version === 'string' && version ? version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export function getUserAgent(): string {
  return `VSCode-OneProvider-Maestro/${getExtensionVersion()}`;
}

/**
 * Headers sent on every OneProvider request.
 *
 * OneProvider does not group usage by app the way some gateways do, so this is
 * plain client identification — useful when support has to tell traffic apart.
 */
export function getAttributionHeaders(): Record<string, string> {
  return {
    'User-Agent': getUserAgent(),
    'X-Client-Name': ONEPROVIDER_APP_TITLE,
    'X-Client-Version': getExtensionVersion(),
  };
}
