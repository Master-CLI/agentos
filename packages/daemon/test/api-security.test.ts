/**
 * Security-hardening tests for ApiServer.
 * Covers: path traversal, malformed JSON, unknown settings keys, oversized bodies.
 *
 * Test setup mirrors e2e.test.ts: spin a Daemon on port 0 in a tmp dir,
 * run initProject first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { Daemon } from '../src/daemon.js';
import { safeRmSync } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-sec-'));
}

/** Low-level HTTP helper that lets us send raw, un-normalised paths. */
function rawRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('API Security — hardening tests', () => {
  let projectDir: string;
  let daemon: Daemon;
  let port: number;

  beforeAll(async () => {
    projectDir = tmpDir();
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'sec-test-project',
      dependencies: {},
      devDependencies: {},
    }));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const x = 1;');

    const { initProject } = await import('../../cli/src/commands/init.js');
    await initProject(projectDir);

    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    port = daemon.port;
  }, 60000);

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  // ── (a) Path traversal via raw http.request with an encoded '..' path ──

  it('(a) encoded .. traversal → 403', async () => {
    // Request a path with percent-encoded directory traversal.
    // Node's http module does NOT normalise path segments, so the raw
    // string reaches the server as-is.
    const result = await rawRequest({
      port,
      method: 'GET',
      path: '/..%2f..%2f..%2fpackage.json',
    });
    expect(result.status).toBe(403);
  });

  it('(a) double-encoded .. traversal → 403', async () => {
    const result = await rawRequest({
      port,
      method: 'GET',
      path: '/%2e%2e%2f..%2fpackage.json',
    });
    expect(result.status).toBe(403);
  });

  // ── (b) Malformed JSON body to POST /api/dialog → 400 ──

  it('(b) malformed JSON to POST /api/dialog → 400', async () => {
    const result = await rawRequest({
      port,
      method: 'POST',
      path: '/api/dialog',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    expect(result.status).toBe(400);
    const json = JSON.parse(result.body) as { error: string };
    expect(json.error).toBe('invalid JSON');
  });

  // ── (c) PUT /api/settings with unknown key → 400 ──

  it('(c) unknown settings key → 400', async () => {
    const result = await rawRequest({
      port,
      method: 'PUT',
      path: '/api/settings',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unknown_key: true }),
    });
    expect(result.status).toBe(400);
    const json = JSON.parse(result.body) as { error: string };
    expect(json.error).toMatch(/unknown setting/);
  });

  it('(c) known settings key (auto_execute) → 200', async () => {
    const result = await rawRequest({
      port,
      method: 'PUT',
      path: '/api/settings',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_execute: false }),
    });
    expect(result.status).toBe(200);
  });

  it('(c) mixed valid + unknown key → 400', async () => {
    const result = await rawRequest({
      port,
      method: 'PUT',
      path: '/api/settings',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_execute: true, evil_key: 'drop table' }),
    });
    expect(result.status).toBe(400);
    const json = JSON.parse(result.body) as { error: string };
    expect(json.error).toMatch(/unknown setting/);
  });

  // ── (d) Oversized body → 413 ──

  it('(d) oversized body to POST /api/dialog → 413', async () => {
    // Send 1 MB + 1 byte — exceeds the 1 MB cap
    const bigBody = 'x'.repeat(1 * 1024 * 1024 + 1);
    const result = await rawRequest({
      port,
      method: 'POST',
      path: '/api/dialog',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bigBody)) },
      body: bigBody,
    });
    expect(result.status).toBe(413);
    const json = JSON.parse(result.body) as { error: string };
    expect(json.error).toBe('payload too large');
  });

  it('(d) oversized body to PUT /api/settings → 413', async () => {
    const bigBody = 'y'.repeat(1 * 1024 * 1024 + 1);
    const result = await rawRequest({
      port,
      method: 'PUT',
      path: '/api/settings',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bigBody)) },
      body: bigBody,
    });
    expect(result.status).toBe(413);
    const json = JSON.parse(result.body) as { error: string };
    expect(json.error).toBe('payload too large');
  });
});
