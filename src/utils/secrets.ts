import * as vscode from 'vscode';
import { normalizeApiKey, isLikelyOneProviderKey } from './apiKeyUtils';
import { ONEPROVIDER_TOPUP_URL } from './branding';

const SECRET_KEY = 'oneprovider-api-key';

/** Managed with VS Code's SecretStorage so the key never lands in settings.json. */
export class SecretsManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the stored key is replaced or deleted. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly secretStorage: vscode.SecretStorage) {}

  async getApiKey(): Promise<string | undefined> {
    const key = await this.secretStorage.get(SECRET_KEY);
    if (!key) {
      return undefined;
    }
    const normalized = normalizeApiKey(key);
    return normalized || undefined;
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key && key.length > 0;
  }

  async setApiKey(key: string): Promise<void> {
    await this.secretStorage.store(SECRET_KEY, normalizeApiKey(key));
    this._onDidChange.fire();
  }

  async deleteApiKey(): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY);
    this._onDidChange.fire();
  }

  /**
   * Prompt for a key. Returns true when a new key was stored.
   *
   * The existing key is shown as bullets rather than in the clear: an input box
   * is screen-shareable, and a pre-filled secret is one screenshot away from a
   * leak. Submitting the bullets unchanged keeps the stored key.
   */
  async promptForApiKey(): Promise<boolean> {
    const existingKey = await this.getApiKey();
    const placeholder = '••••••••';

    const key = await vscode.window.showInputBox({
      title: 'OneProvider API Key',
      prompt: `Enter your OneProvider API key. Get one from ${ONEPROVIDER_TOPUP_URL}`,
      password: true,
      placeHolder: 'sk-...',
      value: existingKey ? placeholder : undefined,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'API key cannot be empty';
        }
        if (value !== placeholder && !isLikelyOneProviderKey(normalizeApiKey(value))) {
          return 'That does not look like a OneProvider key (expected sk-… , at least 20 characters)';
        }
        return undefined;
      },
    });

    if (key && key !== placeholder) {
      await this.setApiKey(key);
      vscode.window.showInformationMessage('✅ OneProvider API key saved.');
      return true;
    }

    return false;
  }
}
