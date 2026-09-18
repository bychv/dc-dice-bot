/**
 * 破坏性命令的按钮二次确认 (docs §16.6).
 *
 * `/pc clr`、`/st clr` 首次执行只列出"将销毁的范围"并回执一行两个按钮；只有命令发起者、
 * 且只在 5 分钟内可以点击确认。登记表放在内存里（一次性、取出即删），所以重启即失效，
 * 这比"重启后还能点到别人旧的确认"更安全。
 *
 * 本模块不 import discord.js：按钮用冻结契约里的 `ApiActionRow` 形状描述，由 adapter 落成
 * 真正的组件。
 */
import type {
  ApiActionRow,
  HandlerDeps,
  InteractionContext,
  PendingAction,
  PendingActions,
  ReplyPayload,
} from '../contracts/bot.ts';
import { fail, ok } from './handlers/options.ts';

/** `custom_id` 前缀，adapter 只做透传，解析在 `handleButtonClick` 里。 */
export const CONFIRM_ID_PREFIX = 'confirm:';
export const CANCEL_ID_PREFIX = 'cancel:';

/** 默认有效期：5 分钟 (docs §16.6)。 */
export const CONFIRM_TTL_MS = 5 * 60 * 1000;

export const EXPIRED_MESSAGE = '该确认已过期或已处理，请重新执行命令。';
export const NOT_OWNER_MESSAGE = '只有命令发起者可以确认。';
export const CANCELLED_MESSAGE = '已取消。';

export interface PendingActionsOptions {
  /** 登记项存活时间，默认 5 分钟 */
  ttlMs?: number;
  /** 注入时钟（测试冻结它） */
  now?: () => number;
}

/**
 * `PendingActions` 是冻结契约，没有暴露 TTL/时钟；把配置挂在 registry 实例上，
 * `askConfirm` 才能按同一个 registry 的配置生成 `expiresAt`（见下面的 WeakMap）。
 */
const REGISTRY_CLOCK = new WeakMap<PendingActions, () => number>();
const REGISTRY_TTL = new WeakMap<PendingActions, number>();

/** 内存登记表：`put` 时清理过期项，`take` 取出即删（防重复点击）。 */
export function createPendingActions(options: PendingActionsOptions = {}): PendingActions {
  const ttlMs = options.ttlMs ?? CONFIRM_TTL_MS;
  const clock = options.now ?? (() => Date.now());
  const actions = new Map<string, PendingAction>();

  function sweep(now: number): void {
    for (const [id, action] of actions) {
      if (action.expiresAt <= now) actions.delete(id);
    }
  }

  /** 存在且未过期才返回；顺手删掉已过期的。 */
  function fresh(id: string): PendingAction | null {
    const action = actions.get(id);
    if (!action) return null;
    if (action.expiresAt <= clock()) {
      actions.delete(id);
      return null;
    }
    return action;
  }

  const registry: PendingActions = {
    put(action: PendingAction): void {
      sweep(clock());
      actions.set(action.id, action);
    },
    take(id: string): PendingAction | null {
      const action = fresh(id);
      if (!action) return null;
      actions.delete(id);
      return action;
    },
    peek(id: string): PendingAction | null {
      return fresh(id);
    },
    sweep,
    size(): number {
      return actions.size;
    },
  };

  REGISTRY_CLOCK.set(registry, clock);
  REGISTRY_TTL.set(registry, ttlMs);
  return registry;
}

let idSeq = 0;

/** 不透明、不可猜的一次性 id；同一次 askConfirm 的两个按钮共用它。 */
function newActionId(): string {
  idSeq += 1;
  const noise = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}${idSeq.toString(36)}${noise}`;
}

export interface AskConfirmSpec {
  /** 回执正文：列出将销毁的范围 + 提示只有发起者可确认 */
  summary: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 确认后真正执行；返回最终回执 */
  onConfirm(): Promise<ReplyPayload> | ReplyPayload;
  /** 取消时的回执（缺省为一句"已取消。"） */
  onCancel?(): ReplyPayload;
}

/**
 * 登记一个待确认动作并返回带"确认执行 / 取消"一行两按钮的回执。
 *
 * 调用方（handler）必须保证：**在按钮被点击之前不改动任何数据**——这正是本函数只返回
 * 回执、把真正的写入放进 `onConfirm` 的原因。
 */
export function askConfirm(
  deps: HandlerDeps,
  ctx: InteractionContext,
  spec: AskConfirmSpec,
): ReplyPayload {
  const clock = REGISTRY_CLOCK.get(deps.confirmations) ?? (() => Date.now());
  const ttlMs = REGISTRY_TTL.get(deps.confirmations) ?? CONFIRM_TTL_MS;
  const id = newActionId();

  deps.confirmations.put({
    id,
    userId: ctx.userId,
    expiresAt: clock() + ttlMs,
    run: async (): Promise<ReplyPayload> => spec.onConfirm(),
    ...(spec.onCancel ? { cancel: (): ReplyPayload => spec.onCancel!() } : {}),
  });

  const row: ApiActionRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 4,
        label: spec.confirmLabel ?? '确认执行',
        custom_id: `${CONFIRM_ID_PREFIX}${id}`,
      },
      {
        type: 2,
        style: 2,
        label: spec.cancelLabel ?? '取消',
        custom_id: `${CANCEL_ID_PREFIX}${id}`,
      },
    ],
  };
  return { content: spec.summary, components: [row] };
}

export interface ParsedConfirmCustomId {
  kind: 'confirm' | 'cancel';
  id: string;
}

/** 只认 `confirm:<id>` / `cancel:<id>`；其余（含空 id）一律视作未知按钮。 */
export function parseConfirmCustomId(customId: string): ParsedConfirmCustomId | null {
  if (customId.startsWith(CONFIRM_ID_PREFIX)) {
    const id = customId.slice(CONFIRM_ID_PREFIX.length);
    return id.length > 0 ? { kind: 'confirm', id } : null;
  }
  if (customId.startsWith(CANCEL_ID_PREFIX)) {
    const id = customId.slice(CANCEL_ID_PREFIX.length);
    return id.length > 0 ? { kind: 'cancel', id } : null;
  }
  return null;
}

/**
 * 按钮点击入口（adapter 调用）。
 *
 * - 未知/过期/已处理 → 公开回执一句"已过期或已处理"（按钮行随即被清掉）
 * - 非发起者 → ephemeral 拒绝，且**不消费**登记项（发起者仍可确认）
 * - confirm → 执行 `run()`；cancel → `cancel?.()` 或"已取消。"
 */
export async function handleButtonClick(
  customId: string,
  userId: string,
  deps: HandlerDeps,
): Promise<ReplyPayload> {
  const parsed = parseConfirmCustomId(customId);
  if (!parsed) return ok(EXPIRED_MESSAGE);

  const registered = deps.confirmations.peek(parsed.id);
  if (!registered) return ok(EXPIRED_MESSAGE);
  if (registered.userId !== userId) return fail(NOT_OWNER_MESSAGE);

  // 只有发起者、且只在确认点下这一刻才消费登记项：take 是同步的，因此重复点击第二次必然落空。
  const action = deps.confirmations.take(parsed.id);
  if (!action) return ok(EXPIRED_MESSAGE);

  if (parsed.kind === 'cancel') {
    return action.cancel ? action.cancel() : ok(CANCELLED_MESSAGE);
  }
  return action.run();
}
