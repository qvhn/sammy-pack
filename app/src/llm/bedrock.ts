/**
 * AWS Bedrock streaming adapter via the Converse API. Implements the same
 * `StreamFn` shape as the other providers so a node can route to Bedrock with
 * `provider: "bedrock"` and `model: "<bedrock-model-id>"`.
 *
 * Because the provider registry keys on a single string, the Bedrock "apiKey"
 * is JSON: {"region","accessKeyId","secretAccessKey","sessionToken"?}. The
 * server builds it from AWS_* env / credentials.json (see resolveProviderKeysSync).
 *
 * First cut: non-streaming Converse (one POST, JSON in/out) surfaced as a
 * single text-delta + done — avoids the AWS event-stream binary framing while
 * fitting the streaming contract. SigV4 signing is verified against the AWS
 * test vector; end-to-end Bedrock acceptance needs a live AWS account.
 *
 * Tool-use / subagents / MCP are Claude-Code-proxy features and are ignored
 * here (Bedrock is text-only in this cut — it's in TEXT_ONLY_PROVIDERS).
 */

import type { StreamEvent } from './anthropic';
import { signRequest, sha256hex } from '../server/aws-sigv4';

export type BedrockStreamParams = {
  apiKey: string; // JSON creds (see module doc)
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
};

type BedrockCreds = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export function parseBedrockCreds(apiKey: string): BedrockCreds | null {
  try {
    const c = JSON.parse(apiKey) as Partial<BedrockCreds>;
    if (c && c.region && c.accessKeyId && c.secretAccessKey) {
      return c as BedrockCreds;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export async function* streamBedrock(
  params: BedrockStreamParams,
): AsyncIterable<StreamEvent> {
  const creds = parseBedrockCreds(params.apiKey);
  if (!creds) {
    throw new Error(
      'Bedrock provider key must be JSON {region, accessKeyId, secretAccessKey}',
    );
  }
  const url =
    `https://bedrock-runtime.${creds.region}.amazonaws.com/model/` +
    `${encodeURIComponent(params.model)}/converse`;
  const body = JSON.stringify({
    messages: params.messages.map(m => ({
      role: m.role,
      content: [{ text: m.content }],
    })),
    ...(params.system ? { system: [{ text: params.system }] } : {}),
    inferenceConfig: { maxTokens: params.maxTokens ?? 4096 },
  });

  const headers = signRequest({
    method: 'POST',
    url,
    region: creds.region,
    service: 'bedrock',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    body,
    headers: {
      'content-type': 'application/json',
      'x-amz-content-sha256': sha256hex(body),
    },
  });

  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Bedrock HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  const text = (json.output?.message?.content ?? [])
    .map(c => c.text ?? '')
    .join('');
  if (text) yield { type: 'text-delta', text };
  yield {
    type: 'done',
    usage: {
      inputTokens: json.usage?.inputTokens ?? 0,
      outputTokens: json.usage?.outputTokens ?? 0,
    },
  };
}
