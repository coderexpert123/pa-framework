import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProxyUrl,
  isPublicHost,
  assertTlsValidationOn,
  parseProxyListText,
  isConnectStageError,
} from '../src/lib/telegram-proxy.js';

// Pure-logic unit tests. The network paths (healthCheckProxy, telegramFetch
// failover) are exercised manually against a live proxy — these tests lock the
// parsing, SSRF, and TLS-guardrail logic that the failover relies on.

describe('parseProxyUrl', () => {
  it('accepts socks5:// with host and port', () => {
    const p = parseProxyUrl('socks5://119.148.51.30:22122');
    assert.deepEqual(p, { url: 'socks5://119.148.51.30:22122', host: '119.148.51.30', port: 22122 });
  });

  it('accepts socks5h:// and normalizes to socks5://', () => {
    const p = parseProxyUrl('socks5h://example.com:1080');
    assert.equal(p?.url, 'socks5://example.com:1080');
  });

  it('extracts credentials when present', () => {
    const p = parseProxyUrl('socks5://user:p%40ss@host:1080');
    assert.equal(p?.userId, 'user');
    assert.equal(p?.password, 'p@ss'); // percent-decoded
  });

  it('rejects http(s) proxies — SOCKS5 only', () => {
    assert.equal(parseProxyUrl('http://host:8080'), null);
    assert.equal(parseProxyUrl('https://host:8080'), null);
  });

  it('rejects missing/garbage/out-of-range port', () => {
    assert.equal(parseProxyUrl('socks5://host'), null);
    assert.equal(parseProxyUrl('socks5://host:0'), null);
    assert.equal(parseProxyUrl('socks5://host:70000'), null);
    assert.equal(parseProxyUrl('not a url'), null);
    assert.equal(parseProxyUrl(''), null);
  });

  it('rejects the MTProto tg:// scheme the user kept sending', () => {
    assert.equal(parseProxyUrl('tg://proxy?server=1.2.3.4&port=443&secret=abc'), null);
    assert.equal(parseProxyUrl('tg://socks?server=1.2.3.4&port=22122'), null);
  });
});

describe('isPublicHost (SSRF guardrail for auto-fetched candidates)', () => {
  it('accepts ordinary public IPs and hostnames', () => {
    assert.equal(isPublicHost('119.148.51.30'), true);
    assert.equal(isPublicHost('proxy.example.com'), true);
    assert.equal(isPublicHost('8.8.8.8'), true);
  });

  it('rejects loopback and localhost', () => {
    assert.equal(isPublicHost('127.0.0.1'), false);
    assert.equal(isPublicHost('localhost'), false);
    assert.equal(isPublicHost('::1'), false);
  });

  it('rejects RFC1918 private ranges', () => {
    assert.equal(isPublicHost('10.1.2.3'), false);
    assert.equal(isPublicHost('192.168.1.1'), false);
    assert.equal(isPublicHost('172.16.0.1'), false);
    assert.equal(isPublicHost('172.31.255.255'), false);
  });

  it('accepts 172.x outside the private /12', () => {
    assert.equal(isPublicHost('172.15.0.1'), true);
    assert.equal(isPublicHost('172.32.0.1'), true);
  });

  it('rejects link-local and IPv6 unique-local', () => {
    assert.equal(isPublicHost('169.254.1.1'), false);
    assert.equal(isPublicHost('fe80::1'), false);
    assert.equal(isPublicHost('fd12:3456::1'), false);
  });
});

describe('parseProxyListText (untrusted source parsing)', () => {
  it('parses bare ip:port lines into socks5:// urls', () => {
    const out = parseProxyListText('208.102.51.6:58208\n69.61.200.104:36181\n');
    assert.deepEqual(out, ['socks5://208.102.51.6:58208', 'socks5://69.61.200.104:36181']);
  });

  it('skips comments, blanks, and garbage; dedupes', () => {
    const out = parseProxyListText('# header\n\n1.2.3.4:1080\nnonsense\n1.2.3.4:1080\n');
    assert.deepEqual(out, ['socks5://1.2.3.4:1080']);
  });

  it('applies the SSRF guardrail to fetched candidates', () => {
    const out = parseProxyListText('127.0.0.1:1080\n10.0.0.5:1080\n8.8.8.8:1080\n');
    assert.deepEqual(out, ['socks5://8.8.8.8:1080']); // private/loopback dropped
  });

  it('extracts ip:port embedded in surrounding markup', () => {
    const out = parseProxyListText('<td>5.6.7.8</td><td>4145</td> 5.6.7.8:4145 trailing');
    assert.equal(out[0], 'socks5://5.6.7.8:4145');
  });
});

describe('isConnectStageError (reroute predicate — guards effectively-once)', () => {
  const withCause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

  it('connect-stage codes → true (request never sent; safe to reroute/failover)', () => {
    for (const c of ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']) {
      assert.equal(isConnectStageError(withCause(c)), true, c);
    }
  });

  it('AbortError / TimeoutError → false (may have been delivered — do NOT reroute)', () => {
    assert.equal(isConnectStageError(Object.assign(new Error('x'), { name: 'AbortError' })), false);
    assert.equal(isConnectStageError(Object.assign(new Error('x'), { name: 'TimeoutError' })), false);
  });

  it('ECONNRESET / post-send socket errors → false (ambiguous)', () => {
    assert.equal(isConnectStageError(withCause('ECONNRESET')), false);
    assert.equal(isConnectStageError(withCause('UND_ERR_SOCKET')), false);
  });

  it('SOCKS proxy connect failure recognized by message → true', () => {
    assert.equal(isConnectStageError(new Error('Socks5 proxy connection failed')), true);
  });

  it('plain application error → false', () => {
    assert.equal(isConnectStageError(new Error('Bad Request')), false);
  });
});

describe('assertTlsValidationOn (token-theft guardrail)', () => {
  it('throws when NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      assert.throws(() => assertTlsValidationOn(), /TLS validation disabled/);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  });

  it('does not throw when TLS validation is on', () => {
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      assert.doesNotThrow(() => assertTlsValidationOn());
    } finally {
      if (prev !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  });
});
