import path from 'node:path';
import process from 'node:process';

import { AutonomousAssistantController } from './app/controller.js';
import { ActoviqClawTui } from './app/tui.js';

function parseWorkspaceOverride(argv: string[]): string | undefined {
  const index = argv.findIndex(arg => arg === '--workspace');
  if (index >= 0 && argv[index + 1]) {
    return path.resolve(argv[index + 1]!);
  }
  return undefined;
}

async function main(): Promise<void> {
  const workspace = parseWorkspaceOverride(process.argv.slice(2));
  const rootDir = workspace ?? process.cwd();
  const controller = new AutonomousAssistantController(rootDir);
  await controller.initialize();
  const tui = new ActoviqClawTui(controller);
  tui.mount();
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('No Actoviq credential was found')) {
    console.error(
      [
        message,
        '',
        'Setup hint:',
        '1. Copy actoviq-claw.runtime.settings.example.json to actoviq-claw.runtime.settings.local.json',
        '2. Fill in ACTOVIQ_BASE_URL / ACTOVIQ_AUTH_TOKEN / ACTOVIQ_MODEL',
        '3. Then rerun npm run dev',
      ].join('\n'),
    );
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
