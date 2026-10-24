import { signRequest } from '../src/server/aws-sigv4';

// AWS SigV4 "get-vanilla" test vector (the canonical published example):
//   AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
//   region us-east-1, service "service", 20150830T123600Z, GET https://example.amazonaws.com/
const VECTOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  now: new Date('2015-08-30T12:36:00Z'),
};
const EXPECTED_SIG =
  '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31';

describe('signRequest (AWS SigV4)', () => {
  it('matches the AWS get-vanilla test vector', () => {
    const h = signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      body: '',
      ...VECTOR,
    });
    expect(h.authorization).toContain(`Signature=${EXPECTED_SIG}`);
    expect(h.authorization).toContain(
      'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request',
    );
    expect(h.authorization).toContain('SignedHeaders=host;x-amz-date');
    expect(h['x-amz-date']).toBe('20150830T123600Z');
  });

  it('is deterministic + well-formed for a signed-body POST (Bedrock shape)', () => {
    const sign = () =>
      signRequest({
        method: 'POST',
        url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet/converse',
        region: 'us-east-1',
        service: 'bedrock',
        accessKeyId: 'AKID',
        secretAccessKey: 'secret',
        body: '{"x":1}',
        headers: { 'content-type': 'application/json' },
        now: new Date('2024-01-02T03:04:05Z'),
      });
    const a = sign();
    const b = sign();
    expect(a.authorization).toBe(b.authorization); // deterministic
    expect(a.authorization).toMatch(/Signature=[a-f0-9]{64}$/);
    expect(a.authorization).toContain('content-type'); // extra header signed
    expect(a.host).toBe('bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('includes a session token in the signed headers when given', () => {
    const h = signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      body: '',
      sessionToken: 'tok',
      ...VECTOR,
    });
    expect(h['x-amz-security-token']).toBe('tok');
    expect(h.authorization).toContain('x-amz-security-token');
  });
});
