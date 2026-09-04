import * as vscode from 'vscode';
import { AccountUsage, SessionUsageSummary } from '../types/models';

/** Fraction of the lifetime top-up below which the balance turns into a warning. */
const LOW_BALANCE_RATIO = 0.1;

/**
 * The status bar readout: what this session burned, and what is left on the key.
 *
 * Two numbers from two different places, which is the point. Session spend is
 * priced locally from the bundled rate card the instant a turn ends, so it moves
 * while you work; the balance comes from OneProvider's own accounting, which
 * settles in the background. The tooltip says which is which so a gap between
 * them reads as lag rather than as a bug.
 */
export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;
  private session?: SessionUsageSummary;
  private account?: AccountUsage;
  private accountError?: string;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.item.name = 'OneProvider Usage';
    this.item.command = 'oneproviderMaestro.openBrowser';
  }

  dispose(): void {
    this.item.dispose();
  }

  setSession(session: SessionUsageSummary): void {
    this.session = session;
    this.render();
  }

  setAccount(account: AccountUsage | undefined, error?: string): void {
    this.account = account;
    this.accountError = error;
    this.render();
  }

  render(): void {
    const mode = vscode.workspace
      .getConfiguration('oneproviderMaestro')
      .get<string>('statusBar.mode', 'both');

    if (mode === 'hidden') {
      this.item.hide();
      return;
    }

    const sessionText = this.session
      ? `${formatUsd(this.session.estimatedCost)} · ${this.session.requests} req`
      : '$0.00 · 0 req';
    const balanceText = this.account ? formatUsd(this.account.snapshot.balance_usd) : '—';

    let text: string;
    if (mode === 'session') {
      text = `$(pulse) ${sessionText}`;
    } else if (mode === 'balance') {
      text = `$(credit-card) ${balanceText}`;
    } else {
      text = `$(pulse) ${sessionText} $(credit-card) ${balanceText}`;
    }

    this.item.text = text;
    this.item.tooltip = this.buildTooltip();
    this.item.backgroundColor = this.isLowBalance()
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  private isLowBalance(): boolean {
    if (!this.account) {
      return false;
    }
    const { balance_usd, quota_usd } = this.account.snapshot;
    if (balance_usd <= 0) {
      return true;
    }
    return quota_usd > 0 && balance_usd / quota_usd < LOW_BALANCE_RATIO;
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportThemeIcons = true;
    md.appendMarkdown('**OneProvider Maestro**\n\n');

    if (this.session) {
      const started = new Date(this.session.startedAt).toLocaleTimeString();
      md.appendMarkdown(`**This session** (since ${started})\n\n`);
      md.appendMarkdown(
        `- ${this.session.requests} request(s) · **${formatUsd(this.session.estimatedCost)}** estimated\n`,
      );
      md.appendMarkdown(
        `- ${formatTokens(this.session.inputTokens)} in · ${formatTokens(this.session.outputTokens)} out` +
          (this.session.cacheReadTokens + this.session.cacheWriteTokens > 0
            ? ` · ${formatTokens(this.session.cacheReadTokens + this.session.cacheWriteTokens)} cache\n`
            : '\n'),
      );
      for (const model of this.session.perModel.slice(0, 3)) {
        md.appendMarkdown(
          `- \`${model.modelId}\` — ${model.requests} req · ${formatUsd(model.estimatedCost)}\n`,
        );
      }
      md.appendMarkdown(
        '\n_Session cost is priced locally from the bundled rate card; OneProvider bills authoritatively._\n\n',
      );
    }

    if (this.account) {
      const { balance_usd, quota_usd, quota_used_usd } = this.account.snapshot;
      md.appendMarkdown('**Account**\n\n');
      md.appendMarkdown(`- Balance: **${formatUsd(balance_usd)}** of ${formatUsd(quota_usd)}\n`);
      md.appendMarkdown(`- Spent so far: ${formatUsd(quota_used_usd)}\n`);
      md.appendMarkdown(`- Status: ${this.account.status}\n`);
      if (this.account.key.expires_at) {
        md.appendMarkdown(
          `- Expires: ${new Date(this.account.key.expires_at).toLocaleDateString()}\n`,
        );
      }
      md.appendMarkdown(
        `\n_Synced ${new Date(this.account.fetchedAt).toLocaleTimeString()} — OneProvider settles charges in the background._`,
      );
    } else if (this.accountError) {
      md.appendMarkdown(`**Account**\n\n- ${this.accountError}\n`);
    }

    md.appendMarkdown('\n\nClick to open the OneProvider Maestro panel.');
    return md;
  }
}

/** Small amounts need more decimals than a currency formatter gives. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '$0.00';
  }
  if (value === 0) {
    return '$0.00';
  }
  if (Math.abs(value) < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(2)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return String(count);
}
