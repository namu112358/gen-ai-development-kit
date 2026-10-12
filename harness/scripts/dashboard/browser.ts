/**
 * 手元のダッシュボードの URL を既定のブラウザで開く。コマンドの選び方は純粋関数（OS ごとにテストする）で、
 * 開けなくても投げず、onFail に知らせるだけ。シェルを通さない（URL の & などを解釈させない）。
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface BrowserCommand {
  command: string;
  args: string[];
}

type Env = Record<string, string | undefined>;

/** OS ごとの「URL を既定のブラウザで開く」コマンド。URL は最後の引数にそのまま1つで入れる */
export function browserCommand(platform: string, url: string, env: Env): BrowserCommand {
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'linux' && env.WSL_DISTRO_NAME) return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

/** `--no-open` が無ければブラウザを開く */
export function wantsOpen(args: string[]): boolean {
  return !args.includes('--no-open');
}

export interface OpenBrowserDeps {
  onFail: (message: string) => void;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform?: string;
  env?: Env;
}

/** URL をブラウザで開く。起動に失敗しても（同期の例外も error のイベントも）投げずに onFail を1回だけ呼ぶ */
export function openBrowser(url: string, deps: OpenBrowserDeps): void {
  const { command, args } = browserCommand(deps.platform ?? process.platform, url, deps.env ?? process.env);
  let failed = false;
  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    deps.onFail(message);
  };
  try {
    const child = (deps.spawn ?? nodeSpawn)(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e: Error) => fail(e.message));
    child.unref();
  } catch (e) {
    fail((e as Error).message);
  }
}
