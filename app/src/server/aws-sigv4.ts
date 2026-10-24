/**
 * Minimal AWS Signature Version 4 signer (node:crypto only) — enough to call
 * the Bedrock Runtime Converse API without the AWS SDK, matching how the
 * OpenAI / Gemini adapters use raw fetch. Implements the standard SigV4
 * algorithm (canonical request → string-to-sign → derived signing key →
 * Authorization header), verified against the published AWS SigV4
 * "get-vanilla" test vector in __tests__/aws-sigv4.test.ts.
 *
 * Not S3 (no payload-unsigned / double-slash quirks); Bedrock is a normal
 * signed-body service.
 */

// Resolve node:crypto at RUNTIME (not a static import): this module is reached
// from the browser bundle (executor → providers → bedrock → here), so a static
// `import 'node:crypto'` would break the web build. SigV4 only ever runs on the
// server/CLI, where getBuiltinModule exists. Same trick the code-node uses.
type NodeCrypto = {
  createHash(a: string): { update(d: string, e: string): { digest(enc: string): string } };
  createHmac(
    a: string,
    k: string | Buffer,
  ): { update(d: string, e: string): { digest(enc?: string): Buffer | string } };
};
let _crypto: NodeCrypto | undefined;
function nodeCrypto(): NodeCrypto {
  if (_crypto) return _crypto;
  const get = (
    globalThis.process as unknown as {
      getBuiltinModule?: (id: string) => unknown;
    }
  )?.getBuiltinModule;
  const c = get?.('node:crypto') as NodeCrypto | undefined;
  if (!c) throw new Error('AWS SigV4 requires a Node runtime (node:crypto)');
  return (_crypto = c);
}

function hmac(key: string | Buffer, data: string): Buffer {
  return nodeCrypto().createHmac('sha256', key).update(data, 'utf8').digest() as Buffer;
}
export function sha256hex(data: string): string {
  return nodeCrypto().createHash('sha256').update(data, 'utf8').digest('hex');
}

/** RFC 3986 encode a single path segment (encodeURIComponent leaves a few
 *  chars SigV4 wants encoded). */
function encodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(
    /[!'()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export type SigV4Input = {
  method: string;
  /** Full request URL (its path is signed; build it with the model id
   *  already encoded so what you sign equals what you send). */
  url: string;
  region: string;
  service: string; // 'bedrock'
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  body: string;
  /** Extra headers to include in the signature (e.g. content-type). */
  headers?: Record<string, string>;
  /** Injectable clock (tests). */
  now?: Date;
};

/** Returns the full header set to send (Authorization + x-amz-date + host +
 *  x-amz-content-sha256 [+ x-amz-security-token] + any extra headers). */
export function signRequest(input: SigV4Input): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const amzDate = iso;
  const dateStamp = iso.slice(0, 8);
  const payloadHash = sha256hex(input.body);

  // Only host + x-amz-date are always signed; the caller adds any extra
  // (content-type, x-amz-content-sha256, …). Keeping the base minimal lets the
  // core algorithm be verified against the AWS "get-vanilla" test vector.
  const signed: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    ...(input.sessionToken
      ? { 'x-amz-security-token': input.sessionToken }
      : {}),
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    ),
  };
  const sortedKeys = Object.keys(signed).sort();
  const canonicalHeaders =
    sortedKeys.map(k => `${k}:${signed[k].trim()}`).join('\n') + '\n';
  const signedHeaders = sortedKeys.join(';');

  const canonicalUri =
    url.pathname === '' || url.pathname === '/'
      ? '/'
      : url.pathname.split('/').map(encodeSegment).join('/');
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeSegment(k), encodeSegment(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...signed, authorization };
}
