/**
 * Discord application-command payload shapes (subset of the REST API we use).
 * Owner: Lead — the manifest in `src/bot/manifest.ts` must deep-equal
 * `docs/discord-commands.json` (enforced by tests/manifest.test.ts).
 */

export const OPTION_TYPE = {
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
  MENTIONABLE: 9,
  NUMBER: 10,
  ATTACHMENT: 11,
} as const;

/** Thread channel types accepted by CHANNEL options (公开子区 / 私密子区 / 公告子区). */
export const THREAD_CHANNEL_TYPES = [11, 12, 10] as const;

export interface ApiChoice {
  name: string;
  value: string | number;
}

export interface ApiOption {
  type: number;
  name: string;
  description: string;
  name_localizations?: Record<string, string>;
  description_localizations?: Record<string, string>;
  required?: boolean;
  options?: ApiOption[];
  choices?: ApiChoice[];
  channel_types?: number[];
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
}

export interface ApiCommand {
  name: string;
  /** 本地化命令名同样是名称，必须满足与 `name` 相同的命名规则（小写） */
  name_localizations?: Record<string, string>;
  description: string;
  description_localizations?: Record<string, string>;
  options?: ApiOption[];
}

export type CommandManifest = ApiCommand[];
