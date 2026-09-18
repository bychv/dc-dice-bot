/**
 * 日志转存 R2（`src/bot/log-upload.ts`）。
 *
 * 关键正确性用**独立 oracle** 校验：本地 devDependency `aws4`（AWS 官方 SDK v2 用的同一份实现）
 * 对同样的请求签名，要求 **Authorization 完全一致**——签名错了 R2 只会回 403 SignatureDoesNotMatch，
 * 靠自测是发现不了的。
 *
 * Run: node tests/bot/log-upload.test.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';

import aws4 from 'aws4';

import {
  amzDates,
  createLogUploader,
  objectKey,
  presignGet,
  readR2Config,
  sanitizeKeyPart,
  sha256Hex,
  signPut,
  type R2Config,
} from '../../src/bot/log-upload.ts';

const AT = new Date('2026-09-18T13:02:11.000Z');

const config: R2Config = {
  endpoint: 'https://89071107abcdef.r2.cloudflarestorage.com',
  bucket: 'dcdice-logs',
  accessKeyId: 'AKIAEXAMPLEACCESSKEY',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'auto',
  prefix: 'logs/',
  publicBaseUrl: null,
  presignTtl: 604800,
};

describe('readR2Config', () => {
  test('一个 R2_* 都没填 → 关闭（继续走 Discord 附件）', () => {
    assert.deepEqual(readR2Config({}), { kind: 'off' });
  });

  test('只给 R2_ACCOUNT_ID 就能推出 endpoint，默认值填好', () => {
    const result = readR2Config({
      R2_ACCOUNT_ID: 'acc123',
      R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
    });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.config.endpoint, 'https://acc123.r2.cloudflarestorage.com');
    assert.equal(result.config.region, 'auto');
    assert.equal(result.config.prefix, 'dcdice-logs/');
    assert.equal(result.config.presignTtl, 604800);
    assert.equal(result.config.publicBaseUrl, null);
  });

  test('填了但不完整 → 明确列出缺哪几项（不静默降级）', () => {
    const result = readR2Config({ R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k' });
    assert.equal(result.kind, 'invalid');
    if (result.kind !== 'invalid') return;
    assert.match(result.error, /R2_SECRET_ACCESS_KEY/);
    assert.match(result.error, /R2_ENDPOINT（或 R2_ACCOUNT_ID）/);
  });

  test('endpoint 协议与 TTL 边界都会校验', () => {
    const base = { R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' };
    assert.equal(readR2Config({ ...base, R2_ENDPOINT: 'acc123.r2.cloudflarestorage.com' }).kind, 'invalid');
    assert.equal(readR2Config({ ...base, R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_PRESIGN_TTL: '30' }).kind, 'invalid');
    assert.equal(readR2Config({ ...base, R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_PRESIGN_TTL: '86400' }).kind, 'ok');
  });

  test('公开域/前缀可覆盖，尾部斜杠被归一化', () => {
    const result = readR2Config({
      R2_ACCOUNT_ID: 'a',
      R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_PUBLIC_BASE_URL: 'https://logs.example.com/',
      R2_PREFIX: 'guild-a',
    });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.config.publicBaseUrl, 'https://logs.example.com');
    assert.equal(result.config.prefix, 'guild-a');
  });
});

describe('对象键', () => {
  test('按年月分目录，人名/中文文件名保留', () => {
    assert.equal(objectKey(config, '阿卡姆_第一夜.txt', AT), 'logs/2026/09/阿卡姆_第一夜.txt');
    assert.equal(objectKey({ prefix: '' }, 'a b.txt', AT), '2026/09/a b.txt');
  });

  test('文件名带路径穿越/非法字符时不会逃出目录', () => {
    const key = objectKey(config, '../../etc/passwd', AT);
    assert.ok(key.startsWith('logs/2026/09/'), key);
    const name = key.slice('logs/2026/09/'.length);
    assert.equal(name.includes('/'), false, `文件名片段不得含 /：${name}`);
    assert.equal(name.includes('..'), false, `不得出现 ..：${name}`);
    assert.equal(name.startsWith('.'), false);
    assert.equal(objectKey(config, 'a/b\\c:d?.txt', AT), 'logs/2026/09/a_b_c_d_.txt');
  });

  test('超长片段按字节截断且不会变成空串', () => {
    const long = '测试'.repeat(100);
    const part = sanitizeKeyPart(long);
    assert.ok(new TextEncoder().encode(part).length <= 80);
    assert.equal(sanitizeKeyPart('...'), 'log');
    assert.equal(sanitizeKeyPart(''), 'log');
  });
});

describe('SigV4 与 aws4 交叉校验', () => {
  test('PUT 的 Authorization 与官方实现逐字符一致', () => {
    const body = new TextEncoder().encode('第一夜\n甲(U1) 2026-09-18 21:02:11\n我们进入地窖\n\n');
    const key = 'logs/2026/09/x.txt';
    const path = `/${config.bucket}/${key}`;
    const { amzDate } = amzDates(AT);
    const contentLength = String(body.length);

    // 让 aws4 与实现签**同一批头**（aws4 见到已有 content-length 就不会自己再加一个）
    const shared = {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': contentLength,
      'x-amz-content-sha256': sha256Hex(body),
      'x-amz-date': amzDate,
    };
    const signed = signPut(config, key, body, 'text/plain; charset=utf-8', AT, {
      'content-length': contentLength,
    });
    const official = aws4.sign(
      {
        host: new URL(config.endpoint).host,
        path,
        method: 'PUT',
        body: Buffer.from(body),
        headers: { ...shared },
        service: 's3',
        region: config.region,
      },
      { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    );
    const officialAuth =
      (official.headers?.['Authorization'] as string | undefined) ??
      (official.headers?.['authorization'] as string | undefined) ??
      '';
    assert.ok(officialAuth.startsWith('AWS4-HMAC-SHA256 '), officialAuth);
    assert.equal(
      signed.headers.authorization?.replace(/\s+/g, ' ').trim(),
      officialAuth.replace(/\s+/g, ' ').trim(),
      '自研 SigV4 与 aws4 的 Authorization 必须一致',
    );
    assert.equal(signed.headers['x-amz-date'], amzDate);
    assert.equal(signed.headers['x-amz-content-sha256'], sha256Hex(body));
    assert.equal(signed.url, `${config.endpoint}/${config.bucket}/${key}`);
  });

  test('空正文（GET 风格签名集合）也与官方实现一致', () => {
    const empty = new Uint8Array(0);
    const key = 'logs/2026/09/empty.txt';
    const path = `/${config.bucket}/${key}`;
    const { amzDate } = amzDates(AT);
    const signed = signPut(config, key, empty, 'text/plain; charset=utf-8', AT);
    const official = aws4.sign(
      {
        host: new URL(config.endpoint).host,
        path,
        method: 'PUT',
        // 不传 body，aws4 就不会加 Content-Length，签名集合 = {content-type,host,x-amz-content-sha256,x-amz-date}
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-amz-content-sha256': sha256Hex(empty),
          'x-amz-date': amzDate,
        },
        service: 's3',
        region: config.region,
      },
      { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    );
    const officialAuth =
      (official.headers?.['Authorization'] as string | undefined) ??
      (official.headers?.['authorization'] as string | undefined) ??
      '';
    assert.equal(
      signed.headers.authorization?.replace(/\s+/g, ' ').trim(),
      officialAuth.replace(/\s+/g, ' ').trim(),
    );
  });

  test('对象键含中文/空格时，URL 与签名使用的路径一致（编码后）', () => {
    const body = new TextEncoder().encode('x');
    const signed = signPut(config, 'logs/2026/09/阿卡姆 第一夜.txt', body, 'text/plain; charset=utf-8', AT);
    assert.match(signed.url, /%E9%98%BF%E5%8D%A1%E5%A7%86%20/);
    assert.ok(signed.url.endsWith('.txt'));
    assert.doesNotMatch(signed.url, /[^\x20-\x7E]/);
    assert.ok(signed.url.includes(`/${config.bucket}/logs/2026/09/`), signed.url);
  });

  test('预签名 GET 的参数齐全、可复算（时间固定）', () => {
    const url = presignGet(config, 'logs/2026/09/x.txt', AT);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '604800');
    assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.equal(parsed.searchParams.get('X-Amz-Date'), '20260918T130211Z');
    assert.match(
      parsed.searchParams.get('X-Amz-Credential') ?? '',
      /^AKIAEXAMPLEACCESSKEY\/20260918\/auto\/s3\/aws4_request$/,
    );
    assert.match(parsed.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
    assert.equal(parsed.host, '89071107abcdef.r2.cloudflarestorage.com');
    assert.equal(parsed.pathname, `/dcdice-logs/logs/2026/09/x.txt`);
  });

  test('amzDates 用 UTC（本地时区不影响签名）', () => {
    assert.deepEqual(amzDates(AT), { amzDate: '20260918T130211Z', dateStamp: '20260918' });
  });
});

describe('上传', () => {
  /** 起一个本地假 R2：记录收到的请求并回 200。 */
  async function withStubServer<T>(handler: (url: string, headers: Record<string, string>, body: string) => void, run: (endpoint: string) => Promise<T>): Promise<T> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        handler(
          request.url ?? '',
          Object.fromEntries(
            Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value ?? '')]),
          ),
          Buffer.concat(chunks).toString('utf8'),
        );
        response.writeHead(200, { ETag: '"stub"' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('PUT 到 /<bucket>/<key>，带签名头与正文；无公开域时回预签名链接', async () => {
    // 用数组收集，避免 TS 把闭包外变量窄化成 null
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const result = await withStubServer(
      (url, headers, body) => {
        seen.push({ url, headers, body });
      },
      async (endpoint) => {
        const uploader = createLogUploader({ ...config, endpoint }, { now: () => AT });
        return uploader.upload({ name: '阿卡姆_第一夜.txt', data: Buffer.from('日志正文\n', 'utf8') });
      },
    );
    const request = seen[0];
    assert.ok(request, '假 R2 必须收到一次请求');
    assert.equal(decodeURIComponent(request.url), `/${config.bucket}/logs/2026/09/阿卡姆_第一夜.txt`);
    assert.equal(request.body, '日志正文\n');
    assert.match(request.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEACCESSKEY\//);
    assert.equal(request.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(request.headers['x-amz-content-sha256'], sha256Hex(new TextEncoder().encode('日志正文\n')));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.presigned, true);
    assert.match(result.url, /X-Amz-Signature=[0-9a-f]{64}$/);
    assert.equal(result.key, 'logs/2026/09/阿卡姆_第一夜.txt');
  });

  test('配了公开域就回直链（不带签名参数）', async () => {
    const result = await withStubServer(
      () => {},
      async (endpoint) => {
        const uploader = createLogUploader(
          { ...config, endpoint, publicBaseUrl: 'https://logs.example.com' },
          { now: () => AT },
        );
        return uploader.upload({ name: 'a.txt', data: Buffer.from('x') });
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.presigned, false);
    assert.equal(result.url, 'https://logs.example.com/logs/2026/09/a.txt');
  });

  test('HTTP 失败 / 网络异常都返回 { ok:false }（调用方回落到附件）', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const uploader = createLogUploader(
        { ...config, endpoint: `http://127.0.0.1:${port}` },
        { now: () => AT },
      );
      const result = await uploader.upload({ name: 'a.txt', data: Buffer.from('x') });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /HTTP 403/);
      assert.match(result.error, /SignatureDoesNotMatch/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const uploader = createLogUploader(
      { ...config, endpoint: 'http://127.0.0.1:1' },
      { now: () => AT, fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch },
    );
    const failed = await uploader.upload({ name: 'a.txt', data: Buffer.from('x') });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.error, /ECONNREFUSED/);
  });
});
