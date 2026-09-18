/**
 * discord.js adapter — the **only** module that imports the library.
 *
 * It converts a `ChatInputCommandInteraction` into the Discord-free `InteractionContext`, implements
 * `Platform` on top of a `Client`, replies with a `ReplyPayload` and records channel chatter into
 * the active log (docs §1.4, §10.1, §11.1).
 */
import {
  ChannelType,
  MessageFlags,
  PermissionsBitField,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type Message,
} from 'discord.js';

import type {
  HandlerDeps,
  InteractionContext,
  OptionReader,
  Platform,
  ReplyPayload,
} from '../contracts/bot.ts';
import type { BotStore } from '../contracts/store.ts';
import { handleButtonClick } from './confirm.ts';
import { appendBotReplyLine, appendUserLogLine, isOutOfCharacterText } from './logFormat.ts';
import { botSpeakerName, speakerName } from './logSpeaker.ts';
import { route } from './router.ts';

// ---------------------------------------------------------------------------
// option reader
// ---------------------------------------------------------------------------

/** Minimal structural view of `CommandInteractionOption` (only what the bot reads). */
interface RawOption {
  name: string;
  type: number;
  value?: unknown;
  user?: { id: string } | null;
  channel?: { id: string } | null;
  options?: RawOption[];
}

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

function findOption(nodes: RawOption[] | undefined, name: string): RawOption | null {
  if (!nodes) return null;
  for (const node of nodes) {
    if (node.name === name && node.type !== SUB_COMMAND && node.type !== SUB_COMMAND_GROUP) {
      return node;
    }
    if (node.options) {
      const nested = findOption(node.options, name);
      if (nested) return nested;
    }
  }
  return null;
}

class DiscordOptionReader implements OptionReader {
  private nodes: RawOption[];
  private subcommandName: string | null;
  private subNodes: RawOption[] | null;

  constructor(nodes: RawOption[], subcommandName: string | null, subNodes: RawOption[] | null) {
    this.nodes = nodes;
    this.subcommandName = subcommandName;
    this.subNodes = subNodes;
  }

  private find(name: string): RawOption | null {
    return findOption(this.nodes, name);
  }

  string(name: string): string | null {
    const node = this.find(name);
    return node && typeof node.value === 'string' ? node.value : null;
  }

  integer(name: string): number | null {
    const node = this.find(name);
    return node && typeof node.value === 'number' ? node.value : null;
  }

  boolean(name: string): boolean | null {
    const node = this.find(name);
    return node && typeof node.value === 'boolean' ? node.value : null;
  }

  user(name: string): string | null {
    const node = this.find(name);
    if (!node) return null;
    if (node.user?.id) return node.user.id;
    return typeof node.value === 'string' ? node.value : null;
  }

  channel(name: string): string | null {
    const node = this.find(name);
    if (!node) return null;
    if (node.channel?.id) return node.channel.id;
    return typeof node.value === 'string' ? node.value : null;
  }

  subcommand(): string | null {
    return this.subcommandName;
  }

  sub(): OptionReader | null {
    return this.subNodes ? new DiscordOptionReader(this.subNodes, null, null) : null;
  }
}

function channelNameOf(channel: unknown): string {
  if (channel && typeof channel === 'object' && 'name' in channel) {
    const name = (channel as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// interaction -> context
// ---------------------------------------------------------------------------

export async function toInteractionContext(
  interaction: ChatInputCommandInteraction,
): Promise<InteractionContext> {
  const channel = interaction.channel;
  const thread = channel && channel.isThread() ? channel : null;

  let isAdmin = false;
  const member = interaction.member as { permissions?: PermissionsBitField; displayName?: string } | null;
  if (member?.permissions instanceof PermissionsBitField) {
    isAdmin =
      member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions.has(PermissionsBitField.Flags.ManageGuild);
  }

  const nodes = interaction.options.data as unknown as RawOption[];
  const subcommandName = interaction.options.getSubcommand(false) ?? null;
  const subNode = subcommandName
    ? nodes.find((node) => node.type === SUB_COMMAND && node.name === subcommandName) ?? null
    : null;
  const grouped =
    subcommandName === null && interaction.options.getSubcommandGroup(false)
      ? nodes.find((node) => node.type === SUB_COMMAND_GROUP) ?? null
      : null;

  return {
    commandName: interaction.commandName,
    guildId: interaction.guildId ?? null,
    channelId: interaction.channelId,
    parentChannelId: thread?.parentId ?? null,
    channelName: channelNameOf(thread ?? channel),
    userId: interaction.user.id,
    displayName: member?.displayName ?? interaction.user.username,
    isAdmin,
    options: new DiscordOptionReader(
      nodes,
      subcommandName,
      subNode?.options ?? grouped?.options ?? null,
    ),
  };
}

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------

interface SendableChannel {
  send(options: { content: string; files?: { attachment: Buffer; name: string }[] }): Promise<{ id: string }>;
}

interface ThreadCapableChannel {
  threads: {
    create(options: { name: string; type: ChannelType }): Promise<{ id: string }>;
  };
}

interface ThreadChannel {
  isThread(): boolean;
  parentId: string | null;
  members: { add(userId: string): Promise<unknown> };
  setArchived(archived: boolean): Promise<unknown>;
}

export function createDiscordPlatform(client: Client): Platform {
  async function fetch(id: string): Promise<unknown> {
    try {
      return await client.channels.fetch(id);
    } catch {
      return null;
    }
  }

  return {
    async createPublicThread(channelId: string, name: string): Promise<string> {
      const channel = (await fetch(channelId)) as ThreadCapableChannel | null;
      if (!channel?.threads) throw new Error('该频道不支持创建子区');
      const thread = await channel.threads.create({ name, type: ChannelType.PublicThread });
      return thread.id;
    },

    async createPrivateThread(channelId: string, name: string): Promise<string> {
      const channel = (await fetch(channelId)) as ThreadCapableChannel | null;
      if (!channel?.threads) throw new Error('该频道不支持创建私密子区');
      const thread = await channel.threads.create({ name, type: ChannelType.PrivateThread });
      return thread.id;
    },

    async addThreadMember(threadId: string, userId: string): Promise<void> {
      const channel = (await fetch(threadId)) as ThreadChannel | null;
      if (channel?.isThread?.()) await channel.members.add(userId);
    },

    async archiveThread(threadId: string): Promise<void> {
      const channel = (await fetch(threadId)) as ThreadChannel | null;
      if (channel?.isThread?.()) await channel.setArchived(true);
    },

    async sendMessage(channelId: string, payload: ReplyPayload): Promise<string> {
      const channel = (await fetch(channelId)) as SendableChannel | null;
      if (typeof channel?.send !== 'function') throw new Error('该频道不能发送消息');
      const files = payload.files?.map((file) => ({ attachment: file.data, name: file.name }));
      const sent = await channel.send(files && files.length > 0 ? { content: payload.content, files } : { content: payload.content });
      return sent.id;
    },

    async threadParent(threadId: string): Promise<string | null> {
      const channel = (await fetch(threadId)) as ThreadChannel | null;
      return channel?.isThread?.() ? channel.parentId : null;
    },

    async threadName(threadId: string): Promise<string | null> {
      const channel = await fetch(threadId);
      const name = channelNameOf(channel);
      return name === 'unknown' ? null : name;
    },

    async canCreateThreads(channelId: string): Promise<boolean> {
      const channel = (await fetch(channelId)) as {
        permissionsFor?: (user: unknown) => PermissionsBitField | null;
      } | null;
      if (!client.user || typeof channel?.permissionsFor !== 'function') return false;
      const permissions = channel.permissionsFor(client.user);
      if (!permissions) return false;
      return (
        permissions.has(PermissionsBitField.Flags.CreatePublicThreads) &&
        permissions.has(PermissionsBitField.Flags.CreatePrivateThreads) &&
        permissions.has(PermissionsBitField.Flags.SendMessagesInThreads)
      );
    },
  };
}

// ---------------------------------------------------------------------------
// replies + logging
// ---------------------------------------------------------------------------

/**
 * Send a `ReplyPayload` (ephemeral when the handler asked for it).
 *
 * `deps` is optional so unit tests can send a reply without a full HandlerDeps; when present the
 * **骰娘回执也会按 Dice! 格式入日志**（`ref DiceEvent.cpp:222` logEcho 的语义），但跳过
 * `/log` 指令自身的回执与 ephemeral 回执（Dice! 用 `strLowerMessage.find(".log") != 0` 排除）。
 */
export async function respond(
  interaction: ChatInputCommandInteraction,
  payload: ReplyPayload,
  deps?: HandlerDeps,
): Promise<void> {
  // 0 字节附件会被 Discord 拒绝（"Cannot send an empty message"），直接不发
  const files = payload.files
    ?.filter((file) => file.data.length > 0)
    .map((file) => ({ attachment: file.data, name: file.name }));
  const hasFiles = files !== undefined && files.length > 0;
  const components = replyComponents(payload);

  const send = async (withFiles: boolean): Promise<void> => {
    if (interaction.deferred || interaction.replied) {
      const options: InteractionEditReplyOptions = { content: payload.content };
      if (withFiles && hasFiles) options.files = files;
      if (components) options.components = components;
      await interaction.editReply(options);
      return;
    }
    const options: InteractionReplyOptions = { content: payload.content };
    if (withFiles && hasFiles) options.files = files;
    if (payload.ephemeral) options.flags = MessageFlags.Ephemeral;
    if (components) options.components = components;
    // No deferral: the interaction is answered within Discord's 3s window; heavy commands are
    // pure REST calls (one thread create + one log write), so this stays well inside it.
    await interaction.reply(options);
  };

  try {
    await send(true);
  } catch (error) {
    console.error(`回执发送失败（${interaction.commandName}）：`, error);
    if (!hasFiles) throw error;

    // 降级 1：先用纯文本把结果送达（JSON 回调路径可靠）
    const note = '\n\n⚠️ 附件上传失败，正在用后续消息补发日志文件…';
    const original = payload.content;
    payload.content = `${original}${note}`;
    try {
      await send(false);
    } finally {
      payload.content = original;
    }

    // 降级 2：followUp 走 webhook 路由（与普通消息上传同一条路），通常能成功
    try {
      await interaction.followUp({ content: '📎 日志文件', files });
    } catch (followUpError) {
      console.error('附件补发（followUp）也失败：', followUpError);
      try {
        await interaction.followUp({
          content: `⚠️ 附件补发失败，日志文件已生成在服务器上：${payload.files?.map((f) => f.name).join('、')}`,
          ephemeral: true,
        });
      } catch {
        // 到这一步只能靠日志了
      }
    }
  }

  if (!deps || payload.ephemeral) return;
  if (interaction.commandName === 'log') return;
  logBotReply(deps, interaction, payload.content);
}

/**
 * 骰娘回执入日志：当前场景没有生效日志时，**子区消息回落到父频道**——与 `createLogRecorder`
 * 里玩家消息的口径一致，否则"在无日志的子区里执行命令"会出现玩家行入日志、骰娘行不入的不对称。
 */
function logBotReply(
  deps: HandlerDeps,
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  text: string,
): void {
  try {
    const self = interaction.client.user;
    // 骰娘那行用**服务器里的昵称**（群里给它设定的名字），没设再回退 Discord 用户名
    const nickname = interaction.guild?.members?.me?.nickname ?? null;
    const input = {
      uid: self?.id ?? '0',
      name: botSpeakerName(nickname, self?.username),
      at: deps.now(),
      text,
    };
    const appended = appendBotReplyLine(deps.store, interaction.channelId, input);
    if (appended === 0) {
      const channel = interaction.channel as
        | { isThread?: () => boolean; parentId?: string | null }
        | null;
      const parentId = channel?.isThread?.() ? (channel.parentId ?? null) : null;
      if (parentId) appendBotReplyLine(deps.store, parentId, input);
    }
  } catch {
    // logging must never take the interaction down
  }
}

/** `ReplyPayload.components` 已是 Discord API 的原始形状，这里只做一次类型桥接。 */
function replyComponents(
  payload: ReplyPayload,
): NonNullable<InteractionReplyOptions['components']> | undefined {
  if (!payload.components || payload.components.length === 0) return undefined;
  return payload.components as unknown as NonNullable<InteractionReplyOptions['components']>;
}

/**
 * Hooks for the run log (`audit.ts`): the Lead wires them in `main.ts` so every dispatch is
 * traceable (command + resolved context + verdict) without handlers knowing about logging.
 */
export interface InteractionHooks {
  /** 上下文解析完成、派发之前 */
  onContext?(context: InteractionContext): void;
  /** 回执已生成、发送之前 */
  onPayload?(context: InteractionContext, payload: ReplyPayload): void;
}

/** Full dispatch for one slash command. */
export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  deps: HandlerDeps,
  hooks?: InteractionHooks,
): Promise<void> {
  const context = await toInteractionContext(interaction);
  hooks?.onContext?.(context);
  const payload = await route(context, deps);
  hooks?.onPayload?.(context, payload);
  await respond(interaction, payload, deps);
}

/**
 * Button dispatch — 破坏性命令的二次确认 (docs §16.6).
 *
 * 成功/取消用 `update` 把原回执改成最终结果并清掉按钮行（按钮随之失效）；被拒（如非发起者）
 * 用 ephemeral `followUp`，原按钮保持可用，让真正的发起者还能确认。
 */
export async function handleButtonInteraction(
  interaction: ButtonInteraction,
  deps: HandlerDeps,
): Promise<void> {
  const payload = await handleButtonClick(interaction.customId, interaction.user.id, deps);
  if (payload.ephemeral) {
    await interaction.followUp({ content: payload.content, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update({ content: payload.content, components: [] });

  // 按钮走的是 update 而不是 respond，所以这里要补记骰娘回执，否则日志里只有危险警告、
  // 看不到最终结果（Dice! 没有按钮流程，但"骰娘回执都入日志"的语义要一致）。
  logBotReply(deps, interaction, payload.content);
}

/**
 * `messageCreate` → log lines (docs §11.1): 每条玩家消息按 **Dice! 行格式**写入该场景当前 `on`
 * 的日志；store 负责按场景/局决定进哪条日志（Bot 自己的消息不记录）。
 *
 * 说话人名字按 `speakerName()` 解析：**角色卡名 > 称呼(/nn) > Discord 显示名**，
 * 且每行重新解析，所以中途换卡名/称呼会从下一行开始生效。
 */
export function createLogRecorder(store: BotStore): (message: Message) => void {
  return (message: Message): void => {
    try {
      if (message.author?.bot) return;
      const channelId = message.channelId;
      if (!channelId) return;
      const parentId = message.channel?.isThread?.() ? (message.channel.parentId ?? null) : null;
      const userId = message.author?.id ?? '0';
      const displayName = message.member?.displayName ?? message.author?.username ?? '未知';
      const name = speakerName(
        store,
        { guildId: message.guildId ?? null, channelId, parentChannelId: parentId, userId },
        displayName,
      );
      const text = message.content?.trim() ?? '';
      const attachments = message.attachments?.size
        ? [...message.attachments.values()].map((file) => `[附件 ${file.name}]`).join(' ')
        : '';
      const line = [text, attachments].filter((part) => part.length > 0).join(' ');
      if (line.length === 0) return;
      // 场外话（以全/半角括号开头）不入日志，与 logPainter 的「过滤 () 发言」同口径
      if (isOutOfCharacterText(line)) return;
      const input = { name, uid: userId, at: new Date(), text: line };
      const appended = appendUserLogLine(store, channelId, input);
      // 子区消息：子区本身常常不是「绑定场景」（游戏绑的是父频道/主场景），
      // 这时按父频道再投一次，否则"在子区里说话"会完全不入日志。
      if (appended === 0 && parentId) appendUserLogLine(store, parentId, input);
    } catch {
      // logging must never take the client down
    }
  };
}
