/**
 * Command manifest — owner: Lead.
 *
 * The authoritative spec is `docs/discord-commands.json` (frozen deliverable of the analysis
 * phase). It is bundled into the package as `src/bot/spec/discord-commands.json` and loaded
 * here, so the bot can never drift from the documented command set. Drift is additionally
 * guarded by `scripts/check-manifest.ts` and `tests/spec/manifest.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OPTION_TYPE, type ApiCommand, type ApiOption, type CommandManifest } from '../contracts/manifest.ts';

const SPEC_URL = new URL('./spec/discord-commands.json', import.meta.url);

function loadSpec(): CommandManifest {
  const raw = readFileSync(fileURLToPath(SPEC_URL), 'utf8');
  return JSON.parse(raw) as CommandManifest;
}

/** Every command the bot registers, exactly as documented. */
export const COMMANDS: CommandManifest = loadSpec();

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

/** Commands that take a free-text argument line and parse it with the original syntax (docs §1.3). */
export const TEXT_PARSED_COMMANDS: readonly string[] = [
  'st',
  'r',
  'rh',
  'rs',
  'rc',
  'ra',
  'sc',
  'en',
];

export function findCommand(name: string): ApiCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Depth-first walk over a command's option tree (subcommands / groups included). */
export function walkOptions(
  command: string,
  visit: (option: ApiOption, path: string[]) => void,
): void {
  const root = findCommand(command);
  if (!root?.options) return;
  const rec = (options: ApiOption[], path: string[]): void => {
    for (const opt of options) {
      visit(opt, [...path, opt.name]);
      if (opt.options) rec(opt.options, [...path, opt.name]);
    }
  };
  rec(root.options, []);
}

export function optionNames(command: string): string[] {
  const names: string[] = [];
  walkOptions(command, (opt, path) => {
    names.push(path.join('.'));
  });
  return names;
}

export { OPTION_TYPE };
