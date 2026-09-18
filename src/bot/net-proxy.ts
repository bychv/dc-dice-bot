/**
 * 出站代理引导 —— 本机需要 HTTP 代理才能访问 Discord（直连 443 超时）。
 *
 * 覆盖两条互不相干的通路：
 *  - REST（discord.js `@discordjs/rest` → undici fetch）：把 undici 全局 dispatcher 换成
 *    `ProxyAgent`，不依赖 `NODE_USE_ENV_PROXY` 之类的实验开关。
 *  - 网关 WebSocket（`@discordjs/ws` → `ws` 包）：`ws` 没有 `agent` 选项、也不认 undici，
 *    它在发起握手时用 Node 的 `https.globalAgent`，所以直接把这颗 agent 换成
 *    `HttpsProxyAgent`（走 CONNECT 隧道）。
 *
 * 环境变量（任一，大小写都认）：`HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`。
 * 未设置时不做任何事，保持直连。
 */
import https from 'node:https';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

export function proxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value && value.length > 0) return value;
  }
  return null;
}

/**
 * 安装代理。返回实际使用的代理 URL（未配置返回 null）。
 * 幂等：重复调用只是重新装一次同样的 agent。
 */
export function installProxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = proxyUrlFromEnv(env);
  if (!url) return null;

  const proxyAgent = new HttpsProxyAgent(url);

  // 网关 WebSocket（`@discordjs/ws` → `ws`）：ws 没有 agent 选项、也不读 https.globalAgent
  // （实测：给 ws 显式传 {agent} 能连上，只改 globalAgent 会一直挂起），所以在最底层拦截
  // `https.request` / `https.get`，凡是没自带 agent 的出站请求都塞进代理 agent。
  // node:https 的 `get` 调用的是模块内部 `request`，所以两个入口都要包。
  const originalRequest = https.request;
  const originalGet = https.get;

  const withAgent = (options: unknown): unknown => {
    if (typeof options === 'string' || options instanceof URL) return options;
    if (options && typeof options === 'object') {
      const record = options as Record<string, unknown>;
      if (!record.agent) return { ...record, agent: proxyAgent };
    }
    return options;
  };

  https.request = function patchedRequest(...args: unknown[]): ReturnType<typeof originalRequest> {
    const [first, ...rest] = args;
    return (originalRequest as (...a: unknown[]) => ReturnType<typeof originalRequest>)(withAgent(first), ...rest);
  } as typeof https.request;

  https.get = function patchedGet(...args: unknown[]): ReturnType<typeof originalGet> {
    const [first, ...rest] = args;
    return (originalGet as (...a: unknown[]) => ReturnType<typeof originalGet>)(withAgent(first), ...rest);
  } as typeof https.get;

  // REST：undici 全局 dispatcher
  setGlobalDispatcher(new ProxyAgent(url));

  return url;
}

/** 打印用：抹掉代理 URL 里的凭据。 */
export function redactProxy(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '<invalid proxy url>';
  }
}
