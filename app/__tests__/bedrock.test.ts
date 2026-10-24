import { streamBedrock, parseBedrockCreds } from '../src/llm/bedrock';

const CREDS = JSON.stringify({
  region: 'us-east-1',
  accessKeyId: 'AKID',
  secretAccessKey: 'secret',
});

describe('streamBedrock', () => {
  it('parses JSON creds, rejects incomplete / non-JSON', () => {
    expect(parseBedrockCreds(CREDS)).toEqual({
      region: 'us-east-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
    });
    expect(parseBedrockCreds('not json')).toBeNull();
    expect(parseBedrockCreds(JSON.stringify({ region: 'us-east-1' }))).toBeNull();
  });

  it('signs a Converse request + yields the response (mocked fetch)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          output: { message: { content: [{ text: 'hi there' }] } },
          usage: { inputTokens: 5, outputTokens: 2 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const events = [];
      for await (const e of streamBedrock({
        apiKey: CREDS,
        model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        system: 'be brief',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        events.push(e);
      }

      const call = calls[0];
      expect(call.url).toContain(
        'bedrock-runtime.us-east-1.amazonaws.com/model/',
      );
      expect(call.url).toContain('/converse');
      const headers = call.init.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);

      const body = JSON.parse(call.init.body as string);
      expect(body.messages).toEqual([
        { role: 'user', content: [{ text: 'hello' }] },
      ]);
      expect(body.system).toEqual([{ text: 'be brief' }]);

      expect(events.find(e => e.type === 'text-delta')).toEqual({
        type: 'text-delta',
        text: 'hi there',
      });
      const done = events.find(e => e.type === 'done');
      expect(done).toMatchObject({
        type: 'done',
        usage: { inputTokens: 5, outputTokens: 2 },
      });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws on a non-2xx response', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('AccessDeniedException', { status: 403 })) as typeof fetch;
    try {
      await expect(
        (async () => {
          for await (const _e of streamBedrock({
            apiKey: CREDS,
            model: 'm',
            messages: [{ role: 'user', content: 'x' }],
          })) {
            void _e;
          }
        })(),
      ).rejects.toThrow(/Bedrock HTTP 403/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws a clear error when the key is not JSON creds', async () => {
    await expect(
      (async () => {
        for await (const _e of streamBedrock({
          apiKey: 'sk-not-aws',
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
        })) {
          void _e;
        }
      })(),
    ).rejects.toThrow(/must be JSON/);
  });
});
