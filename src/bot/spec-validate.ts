/**
 * Application-command payload validation — owner: Lead.
 *
 * Mirrors the rules Discord actually enforces at `PUT /applications/{id}/commands`, so a bad
 * manifest fails locally with a readable message instead of a 400 `Invalid Form Body`:
 *   - command/option names: `^[-_\p{L}\p{N}]{1,32}$` and lowercase where a lowercase variant exists
 *   - **name_localizations values follow the same naming rules** (this is what bit us: `zh-CN: "KP"`)
 *   - descriptions: 1-100 chars, base and every localization
 *   - ≤25 options per level, ≤25 choices, choices only for STRING/INTEGER/NUMBER
 *   - `autocomplete` not combined with `choices`
 *   - `channel_types` only on CHANNEL options
 *   - required options before optional ones
 */
import { OPTION_TYPE, type ApiCommand, type ApiOption } from '../contracts/manifest.ts';

const NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;

function checkLocalizations(
  what: string,
  locs: Record<string, string> | undefined,
  kind: 'name' | 'description',
  errors: string[],
): void {
  if (!locs) return;
  for (const [locale, value] of Object.entries(locs)) {
    if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(locale)) {
      errors.push(`${what}: 非法 locale "${locale}"`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`${what} [${locale}]: 值必须是字符串`);
      continue;
    }
    if (kind === 'name') {
      if (!NAME_RE.test(value)) errors.push(`${what} [${locale}]="${value}": 名称不匹配 ${NAME_RE}`);
      else if (value !== value.toLowerCase()) {
        errors.push(`${what} [${locale}]="${value}": 名称有大写变体，Discord 要求小写`);
      }
    } else if (value.length < 1 || value.length > 100) {
      errors.push(`${what} [${locale}]: 描述长度 ${value.length} 不在 1-100`);
    }
  }
}

function checkOptions(commandName: string, options: ApiOption[] | undefined, errors: string[]): void {
  if (!options) return;
  if (options.length > 25) errors.push(`${commandName}: 选项数 ${options.length} > 25`);
  const seen = new Set<string>();
  let sawOptional = false;
  for (const option of options) {
    const path = `${commandName}.${option.name}`;
    if (!NAME_RE.test(option.name)) errors.push(`${path}: 选项名不匹配 ${NAME_RE}`);
    else if (option.name !== option.name.toLowerCase()) errors.push(`${path}: 选项名未小写`);
    if (seen.has(option.name)) errors.push(`${path}: 选项名重复`);
    seen.add(option.name);
    checkLocalizations(`${path}.name_localizations`, option.name_localizations, 'name', errors);
    checkLocalizations(`${path}.description_localizations`, option.description_localizations, 'description', errors);
    if (typeof option.description !== 'string' || option.description.length < 1 || option.description.length > 100) {
      errors.push(`${path}: 描述长度不在 1-100`);
    }

    const isSubcommand = option.type === OPTION_TYPE.SUB_COMMAND || option.type === OPTION_TYPE.SUB_COMMAND_GROUP;
    if (isSubcommand) {
      if (option.type === OPTION_TYPE.SUB_COMMAND_GROUP && !option.options?.length) {
        errors.push(`${path}: 子命令组下不能没有子命令`);
      }
      if (option.choices) errors.push(`${path}: 子命令不能带 choices`);
    } else if (option.options) {
      errors.push(`${path}: 叶子选项不能带嵌套 options`);
    }
    if (option.choices) {
      if (![3, 4, 10].includes(option.type)) errors.push(`${path}: 该类型不支持 choices`);
      if (option.choices.length > 25) errors.push(`${path}: choices 数 > 25`);
    }
    if (option.autocomplete) {
      if (option.choices) errors.push(`${path}: autocomplete 与 choices 互斥`);
      if (![3, 4, 10].includes(option.type)) errors.push(`${path}: 该类型不支持 autocomplete`);
    }
    if (option.channel_types) {
      if (option.type !== OPTION_TYPE.CHANNEL) errors.push(`${path}: channel_types 只能用于 CHANNEL`);
      if (option.channel_types.length === 0) errors.push(`${path}: channel_types 为空`);
    }
    if (option.min_value !== undefined || option.max_value !== undefined) {
      if (option.type !== 4 && option.type !== 10) errors.push(`${path}: min/max_value 只能用于 INTEGER/NUMBER`);
    }

    const required = option.required === true;
    if (required && sawOptional) errors.push(`${path}: 必填选项不能排在可选项之后`);
    if (!required) sawOptional = true;

    if (option.options) checkOptions(commandName, option.options, errors);
  }
}

/** Returns human-readable problems; an empty array means the payload should be accepted. */
export function validateManifest(commands: readonly ApiCommand[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  if (commands.length > 100) errors.push(`全局命令数 ${commands.length} > 100`);
  for (const command of commands) {
    if (!NAME_RE.test(command.name)) errors.push(`${command.name}: 命令名不匹配 ${NAME_RE}`);
    else if (command.name !== command.name.toLowerCase()) errors.push(`${command.name}: 命令名未小写`);
    if (names.has(command.name)) errors.push(`${command.name}: 命令名重复`);
    names.add(command.name);
    checkLocalizations(`${command.name}.name_localizations`, command.name_localizations, 'name', errors);
    checkLocalizations(
      `${command.name}.description_localizations`,
      command.description_localizations,
      'description',
      errors,
    );
    if (typeof command.description !== 'string' || command.description.length < 1 || command.description.length > 100) {
      errors.push(`${command.name}: 描述长度不在 1-100`);
    }
    checkOptions(command.name, command.options, errors);
  }
  return errors;
}
