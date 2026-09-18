/**
 * Slash 命令的**多服务器同步**（deploy.ts / main.ts / scripts/sync-commands.ts 共用）。
 *
 * 背景：命令按 guild 注册才"即时生效"，但 guild 注册只覆盖一个服务器——bot 被邀请到新服务器后
 * 那里一条命令都没有（客户端里 `/` 列表是空的）。这个模块负责：
 *   - `parseGuildIds()`：从环境变量里解析出要同步的 guild 列表（逗号/空格分隔、去重、只留雪花号）；
 *   - `guildCommandRoute()`：guild 命令的 REST 路径（纯字符串，避免把 discord.js 拖进本模块）；
 *   - `registerGuildCommands()`：逐服务器 PUT 覆盖（幂等），返回真正写入的 guild 列表。
 *
 * 只做 guild 作用域、不碰全局：同一 guild 里同时存在全局与 guild 同名命令时客户端会列两套
 * （deploy.ts 的老注释），所以同步策略是"每个服务器各注册一份 guild 命令，全局保持为空"。
 */

/** 只需要 `put` 的最小 REST 形状，方便测试注入假对象（discord.js 的 REST 也满足）。 */
export interface CommandRest {
  put(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
}

/** Discord 雪花号（guild id）的形态：纯数字，长度 17-20。 */
const SNOWFLAKE = /^\d{17,20}$/;

/** 把多个环境变量值拆成 guild id 列表：逗号/空白分隔，去重，非法值丢弃。 */
export function parseGuildIds(...raw: (string | undefined | null)[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value) continue;
    for (const part of value.split(/[\s,;]+/)) {
      const id = part.trim();
      if (!SNOWFLAKE.test(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** guild 命令的 REST 路径（与 discord.js `Routes.applicationGuildCommands` 同形）。 */
export function guildCommandRoute(applicationId: string, guildId: string): `/${string}` {
  return `/applications/${applicationId}/guilds/${guildId}/commands`;
}

/** 全局命令的 REST 路径。 */
export function globalCommandRoute(applicationId: string): `/${string}` {
  return `/applications/${applicationId}/commands`;
}

/**
 * 把命令清单 PUT 到每个 guild（覆盖式、幂等）；返回成功写入的 guild id。
 * 单个服务器失败不阻断其它服务器（返回结果里把失败项汇总抛出）。
 */
export async function registerGuildCommands(
  rest: CommandRest,
  applicationId: string,
  guildIds: string[],
  body: unknown,
): Promise<string[]> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const guildId of guildIds) {
    try {
      await rest.put(guildCommandRoute(applicationId, guildId), { body });
      done.push(guildId);
    } catch {
      failed.push(guildId);
    }
  }
  if (failed.length > 0) {
    throw new Error(`以下服务器注册失败：${failed.join('、')}（已成功：${done.join('、') || '无'}）`);
  }
  return done;
}
