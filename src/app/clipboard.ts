import { spawn } from 'node:child_process';

function copyWithCommand(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Clipboard command failed: ${command} (${code ?? 'unknown'})`));
      }
    });
    child.stdin.end(text);
  });
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (process.platform === 'win32') {
    await copyWithCommand('clip', [], text);
    return;
  }

  if (process.platform === 'darwin') {
    await copyWithCommand('pbcopy', [], text);
    return;
  }

  try {
    await copyWithCommand('xclip', ['-selection', 'clipboard'], text);
  } catch {
    await copyWithCommand('xsel', ['--clipboard', '--input'], text);
  }
}
