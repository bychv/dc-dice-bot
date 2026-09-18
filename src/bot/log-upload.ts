/**
 * 日志文件转存到 **Cloudflare R2**（S3 兼容）。
 *
 * 为什么不用附件：Discord 的附件上传会超时/被拒（`/log end` 之前就出现过 AbortError），
 * 日志文件改成上传到 R2 后只回一条链接，顺带解决"文件散落在 DC、过期就没了"的问题。
 *
 * 实现要点：
 *   - **不引入运行时依赖**：SigV4（AWS Signature Version 4）用 `node:crypto` 手写，
 *     服务固定 `s3`、region 默认 `auto`，按 R2 的 path-style 端点寻址
 *     `https://<account id>.r2.cloudflarestorage.com/<bucket>/<key>`。
 *   - 上传用 `PUT` + `x-amz-content-sha256`；下载链接二选一：
 *       1. 配了 `R2_PUBLIC_BASE_URL`（自定义域/R2 公开域）→ 直接用公开直链；
 *       2. 否则生成 **预签名 GET**（默认 7 天有效，`R2_PRESIGN_TTL` 可调）。
 *   - 未配置 R2（一个 `R2_*` 都没填）时 `readR2Config()` 返回 `null` → 调用方继续走附件。
 *
 * 环境变量：
 *   R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   必填
 *   R2_ENDPOINT 或 R2_ACCOUNT_ID                         二选一（endpoint 可省）
 *   R2_PREFIX（默认 `dcdice-logs/`）、R2_PUBLIC_BASE_URL、R2_PRESIGN_TTL（默认 604800 秒）
 */
import { createHash, createHmac } from 'node:crypto';

import type { OutgoingFile } from '../contracts/bot.ts';

export interface R2Config {
  /** 不带 bucket、不带尾斜杠，如 `https://<account id>.r2.cloudflarestorage.com` */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** SigV4 scope 里的 region；R2 固定用 `auto` */
  region: string;
  /** 对象键前缀（`''` 表示直接放根） */
  prefix: string;
  /** 有公开域时用它拼直链；否则用预签名链接 */
  publicBaseUrl: string | null;
  /** 预签名链接有效期（秒），1-604800 */
  presignTtl: number;
}

export type R2ConfigResult =
  | { kind: 'off' }
  | { kind: 'ok'; config: R2Config }
  | { kind: 'invalid'; error: string };

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/** 读环境变量；一个 `R2_*` 都没填 = 功能关闭，填了但不完整 = 报错（宁可启动时吵，也别静默走附件）。 */
export function readR2Config(env: NodeJS.ProcessEnv = process.env): R2ConfigResult {
  const endpoint = trimmed(env.R2_ENDPOINT) || (trimmed(env.R2_ACCOUNT_ID) ? `https://${trimmed(env.R2_ACCOUNT_ID)}.r2.cloudflarestorage.com` : '');
  const bucket = trimmed(env.R2_BUCKET);
  const accessKeyId = trimmed(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = trimmed(env.R2_SECRET_ACCESS_KEY);
  const prefix = env.R2_PREFIX === undefined ? 'dcdice-logs/' : trimmed(env.R2_PREFIX);
  const publicBaseUrl = trimmed(env.R2_PUBLIC_BASE_URL) || null;
  const ttlRaw = trimmed(env.R2_PRESIGN_TTL);
  const presignTtl = ttlRaw === '' ? 604800 : Number(ttlRaw);

  const anySet = [endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl ?? '', ttlRaw].some(
    (value) => value.length > 0,
  );
  if (!anySet) return { kind: 'off' };

  const missing: string[] = [];
  if (bucket === '') missing.push('R2_BUCKET');
  if (accessKeyId === '') missing.push('R2_ACCESS_KEY_ID');
  if (secretAccessKey === '') missing.push('R2_SECRET_ACCESS_KEY');
  if (endpoint === '') missing.push('R2_ENDPOINT（或 R2_ACCOUNT_ID）');
  if (missing.length > 0) {
    return { kind: 'invalid', error: `R2 配置不完整，缺少：${missing.join('、')}` };
  }
  if (!/^https?:\/\//.test(endpoint)) {
    return { kind: 'invalid', error: `R2_ENDPOINT 必须以 http(s):// 开头（当前：${endpoint}）` };
  }
  if (!Number.isFinite(presignTtl) || presignTtl < 60 || presignTtl > 604800) {
    return { kind: 'invalid', error: `R2_PRESIGN_TTL 必须在 60-604800 秒之间（当前：${ttlRaw}）` };
  }
  return {
    kind: 'ok',
    config: {
      endpoint: endpoint.replace(/\/+$/, ''),
      bucket,
      accessKeyId,
      secretAccessKey,
      region: trimmed(env.R2_REGION) || 'auto',
      prefix,
      publicBaseUrl: publicBaseUrl ? publicBaseUrl.replace(/\/+$/, '') : null,
      presignTtl,
    },
  };
}

// ---- 对象键 -------------------------------------------------------------

const ILLEGAL_KEY_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_PART = 80;

/**
 * 单个文件名片段清洗：`/`、`\`、控制字符等换成 `_`，压掉 `..` 段落与首尾点，
 * 限长（CJK 按字节算）。日志文件名本来已由 store 清洗过，这里是**纵深防御**——
 * 对象键绝不能被文件名带出 `../` 或额外的目录层级。
 */
export function sanitizeKeyPart(value: string, fallback = 'log'): string {
  const cleaned = (value ?? '')
    .replace(ILLEGAL_KEY_CHARS, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (cleaned.length === 0) return fallback;
  const encoder = new TextEncoder();
  if (encoder.encode(cleaned).length <= MAX_PART) return cleaned;
  let out = '';
  for (const char of cleaned) {
    if (encoder.encode(out + char).length > MAX_PART) break;
    out += char;
  }
  return out.length > 0 ? out : fallback;
}

/** `prefix + YYYY/MM/<文件名>`（按导出时间分目录，方便按时间找）。 */
export function objectKey(config: Pick<R2Config, 'prefix'>, fileName: string, at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const folder = `${at.getFullYear()}/${pad(at.getMonth() + 1)}`;
  const prefix = config.prefix.replace(/^\/+/, '');
  return `${prefix}${folder}/${sanitizeKeyPart(fileName, 'log.txt')}`;
}

// ---- SigV4 --------------------------------------------------------------

/** AWS 要求的 RFC3986 编码（encodeURIComponent 少编码 `!'()*`）。 */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 路径编码：逐段编码、保留 `/`（S3 的 canonical URI 不做二次编码）。 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => rfc3986(segment))
    .join('/');
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(config: R2Config, date: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/** `YYYYMMDDTHHMMSSZ` / `YYYYMMDD`（UTC）。 */
export function amzDates(at: Date): { amzDate: string; dateStamp: string } {
  const iso = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface SignedUpload {
  url: string;
  headers: Record<string, string>;
}

/**
 * 签名一个 `PUT`（含 `x-amz-content-sha256`），返回可直接 `fetch` 的 URL 与请求头。
 * `extraHeaders` 会一并参与签名（测试用它与 aws4 对齐 `content-length` 的签名集合）。
 */
export function signPut(
  config: R2Config,
  key: string,
  body: Uint8Array,
  contentType: string,
  at: Date,
  extraHeaders: Record<string, string> = {},
): SignedUpload {
  const { amzDate, dateStamp } = amzDates(at);
  const host = new URL(config.endpoint).host;
  const canonicalUri = encodePath(`/${config.bucket}/${key}`);
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraHeaders)) headers[name.toLowerCase()] = value;
  headers['content-type'] = contentType;
  headers.host = host;
  headers['x-amz-content-sha256'] = payloadHash;
  headers['x-amz-date'] = amzDate;
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(config, dateStamp)).update(stringToSign, 'utf8').digest('hex');

  return {
    url: `${config.endpoint}${canonicalUri}`,
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    },
  };
}

/** 生成预签名 `GET` 链接（只签 host，payload 用 `UNSIGNED-PAYLOAD`）。 */
export function presignGet(config: R2Config, key: string, at: Date): string {
  const { amzDate, dateStamp } = amzDates(at);
  const host = new URL(config.endpoint).host;
  const canonicalUri = encodePath(`/${config.bucket}/${key}`);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(config.presignTtl)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(config, dateStamp)).update(stringToSign, 'utf8').digest('hex');

  return `${config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---- 上传 ---------------------------------------------------------------

export interface LogUploadSuccess {
  ok: true;
  key: string;
  /** 回复给玩家的链接 */
  url: string;
  /** true = 预签名（有有效期），false = 公开直链 */
  presigned: boolean;
}

export type LogUploadFailure = { ok: false; error: string };

export type LogUploadResult = LogUploadSuccess | LogUploadFailure;

/** 上传一个 `Uint8Array`（日志文件）。`fetchImpl` 便于测试注入。 */
export async function uploadObject(
  config: R2Config,
  key: string,
  body: Uint8Array,
  at: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<LogUploadResult> {
  const signed = signPut(config, key, body, 'text/plain; charset=utf-8', at);
  try {
    const response = await fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, error: `R2 上传失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}` };
    }
  } catch (error) {
    return { ok: false, error: `R2 上传失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (config.publicBaseUrl) {
    return { ok: true, key, url: `${config.publicBaseUrl}/${encodePath(key)}`, presigned: false };
  }
  return { ok: true, key, url: presignGet(config, key, at), presigned: true };
}

/** 供 `HandlerDeps.logUpload` 使用的端口实现（`{ ok:false }` 时调用方回落到附件）。 */
export function createLogUploader(
  config: R2Config,
  options: { now?: () => Date; fetchImpl?: typeof fetch } = {},
): { upload(file: OutgoingFile): Promise<LogUploadResult> } {
  const now = options.now ?? ((): Date => new Date());
  return {
    upload(file: OutgoingFile): Promise<LogUploadResult> {
      const at = now();
      const key = objectKey(config, file.name, at);
      return uploadObject(config, key, new Uint8Array(file.data), at, options.fetchImpl ?? fetch);
    },
  };
}
