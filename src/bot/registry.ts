/**
 * Handler registry — one entry per documented command (docs §2 / `docs/discord-commands.json`).
 *
 * `COMMAND_NAMES` comes from the (Lead-owned) manifest, so a drift between the registered slash
 * commands and the handlers is detectable: `missingHandlers()` / `handlersWithoutCommand()` must
 * both be empty (covered by `tests/bot/registry.test.ts`).
 */
import type { CommandHandler } from '../contracts/bot.ts';
import { COMMAND_NAMES } from './manifest.ts';

import { helpHandler } from './handlers/help.ts';
import { rulesHandler } from './handlers/rules.ts';
import { rHandler, rsHandler } from './handlers/roll.ts';
import { rhHandler } from './handlers/rh.ts';
import { gameHandler } from './handlers/game.ts';
import { pcHandler } from './handlers/pc.ts';
import { stHandler } from './handlers/st.ts';
import { enHandler, raHandler, rcHandler, scHandler } from './handlers/check.ts';
import { setcocHandler } from './handlers/setcoc.ts';
import { liHandler, tiHandler } from './handlers/madness.ts';
import { logHandler } from './handlers/log.ts';
import { nnHandler, nnnHandler } from './handlers/nickname.ts';
import { nameHandler } from './handlers/name.ts';

export const HANDLERS: Readonly<Record<string, CommandHandler>> = {
  help: helpHandler,
  rules: rulesHandler,
  r: rHandler,
  rh: rhHandler,
  rs: rsHandler,
  game: gameHandler,
  pc: pcHandler,
  st: stHandler,
  rc: rcHandler,
  ra: raHandler,
  setcoc: setcocHandler,
  sc: scHandler,
  ti: tiHandler,
  li: liHandler,
  en: enHandler,
  log: logHandler,
  nn: nnHandler,
  nnn: nnnHandler,
  name: nameHandler,
};

export const HANDLER_NAMES: readonly string[] = Object.keys(HANDLERS);

export function createRegistry(): Record<string, CommandHandler> {
  return { ...HANDLERS };
}

/** Documented commands with no handler (must be empty). */
export function missingHandlers(): string[] {
  return COMMAND_NAMES.filter((name) => !(name in HANDLERS));
}

/** Handlers for commands that are not in the manifest (must be empty). */
export function handlersWithoutCommand(): string[] {
  return HANDLER_NAMES.filter((name) => !COMMAND_NAMES.includes(name));
}

export function handlerFor(commandName: string): CommandHandler | undefined {
  const name = commandName.startsWith('/') ? commandName.slice(1) : commandName;
  return HANDLERS[name];
}
