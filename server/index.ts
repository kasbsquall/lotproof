// This file is part of Lotproof.
// SPDX-License-Identifier: Apache-2.0
// HTTP front of the demo service. One chain job runs at a time (one wallet),
// a short queue absorbs bursts, and each IP can start a few jobs per hour.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { LotproofChain, logger, NETWORK } from './chain.js';

const PORT = Number(process.env['PORT'] ?? 8787);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const MAX_QUEUE = 3;
const JOBS_PER_IP_PER_HOUR = Number(process.env['JOBS_PER_IP_PER_HOUR'] ?? 6);
// Global cap: every chain job spends DUST from the one demo wallet, whoever starts it.
const JOBS_PER_HOUR = Number(process.env['JOBS_PER_HOUR'] ?? 30);
const HOUR_MS = 3_600_000;
const JOB_TTL_MS = HOUR_MS;
// Unset by default: the web view is served from the same origin and needs no CORS.
const ALLOWED_ORIGIN = process.env['ALLOWED_ORIGIN'];

type JobKind = 'measure' | 'tamper' | 'disclose' | 'audit';
type Job = {
  id: string;
  kind: JobKind;
  step: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  queuedAt: string;
  result?: unknown;
  error?: string;
};

mkdirSync('data', { recursive: true });
const chain = new LotproofChain();
const jobs = new Map<string, Job>();
const queue: { job: Job; run: (j: Job) => Promise<unknown> }[] = [];
const ipHits = new Map<string, number[]>();
let globalHits: number[] = [];
let running = false;
let ready = false;
let startError: string | undefined;

async function pump(): Promise<void> {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  next.job.status = 'running';
  try {
    next.job.result = await next.run(next.job);
    next.job.status = 'done';
    next.job.step = 'done';
  } catch (e) {
    next.job.status = 'failed';
    next.job.error = 'The chain operation failed. Try again in a minute.';
    logger.error({ err: String(e) }, `job ${next.job.id} failed`);
  } finally {
    running = false;
    void pump();
  }
}

type Verdict = 'ok' | 'ip' | 'global';

function allow(ip: string): Verdict {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < HOUR_MS);
  if (globalHits.length >= JOBS_PER_HOUR) return 'global';
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= JOBS_PER_IP_PER_HOUR) return 'ip';
  ipHits.set(ip, [...recent, now]);
  globalHits = [...globalHits, now];
  return 'ok';
}

/** Drops finished jobs and idle addresses after an hour, so memory stays bounded. */
function prune(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if ((j.status === 'done' || j.status === 'failed') && now - Date.parse(j.queuedAt) > JOB_TTL_MS) jobs.delete(id);
  }
  for (const [ip, hits] of ipHits) {
    if (!hits.some((t) => now - t < HOUR_MS)) ipHits.delete(ip);
  }
}
setInterval(prune, 10 * 60_000).unref();

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json',
    ...(ALLOWED_ORIGIN
      ? {
          'access-control-allow-origin': ALLOWED_ORIGIN,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        }
      : {}),
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000) throw new Error('Body too large');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function enqueue(res: ServerResponse, ip: string, kind: JobKind, run: (j: Job) => Promise<unknown>): void {
  if (!ready) return send(res, 503, { error: startError ? 'Service failed to start' : 'Service is starting' });
  if (queue.length >= MAX_QUEUE) return send(res, 429, { error: 'Queue is full, try again shortly' });
  const verdict = allow(ip);
  if (verdict === 'ip') return send(res, 429, { error: 'Hourly demo limit reached for this address' });
  if (verdict === 'global') return send(res, 429, { error: 'The demo has reached its hourly limit of chain transactions. Try again later.' });
  const job: Job = { id: randomUUID(), kind, step: 'queued', status: 'queued', queuedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  queue.push({ job, run });
  void pump();
  send(res, 202, { jobId: job.id, position: queue.length });
}

const WEB_ROOT = resolve('web');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT + sep)) return send(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ready, network: NETWORK, contractAddress: chain.address ?? null, queue: queue.length, running });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (!ready) return send(res, 503, { error: 'Service is starting' });
      return send(res, 200, await chain.publicView());
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      return job ? send(res, 200, job) : send(res, 404, { error: 'Unknown job' });
    }
    if (req.method === 'POST' && url.pathname === '/api/demo/lots') {
      const body = await readJson(req);
      const defects = Number(body['defects'] ?? 0);
      if (!Number.isInteger(defects) || defects < 0 || defects > 4) return send(res, 400, { error: 'defects must be 0 to 4' });
      return enqueue(res, ip, 'measure', (j) => chain.measureAndProve(defects, (s) => (j.step = s)));
    }
    if (req.method === 'POST' && url.pathname === '/api/demo/tamper') {
      return enqueue(res, ip, 'tamper', (j) => chain.tamperAttempt((s) => (j.step = s)));
    }
    const discloseMatch = url.pathname.match(/^\/api\/lots\/([0-9a-f]{64})\/disclose$/);
    if (req.method === 'POST' && discloseMatch) {
      const body = await readJson(req);
      const index = Number(body['index']);
      if (!Number.isInteger(index) || index < 0 || index > 31) return send(res, 400, { error: 'index must be 0 to 31' });
      if (!chain.canDisclose(discloseMatch[1])) return send(res, 409, { error: 'Only a proven lot can have a part disclosed' });
      return enqueue(res, ip, 'disclose', (j) => {
        j.step = 'proving';
        return chain.disclose(discloseMatch[1], index);
      });
    }
    const auditMatch = url.pathname.match(/^\/api\/lots\/([0-9a-f]{64})\/audit$/);
    if (req.method === 'POST' && auditMatch) {
      if (!chain.canAudit(auditMatch[1])) return send(res, 409, { error: 'This lot cannot be audited, or was audited already' });
      return enqueue(res, ip, 'audit', (j) => chain.audit(auditMatch[1], (s) => (j.step = s)));
    }
    const supplierMatch = url.pathname.match(/^\/api\/supplier\/lots\/([0-9a-f]{64})$/);
    if (req.method === 'GET' && supplierMatch) {
      if (!ready) return send(res, 503, { error: 'Service is starting' });
      const lot = await chain.supplierLot(supplierMatch[1]);
      return lot ? send(res, 200, lot) : send(res, 404, { error: 'No supplier data for this lot' });
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    logger.warn({ err: String(e) }, 'bad request');
    send(res, 400, { error: 'Bad request' });
  }
});

server.listen(PORT, HOST, () => logger.info(`Lotproof demo API on http://${HOST}:${PORT} (${NETWORK})`));

chain
  .start()
  .then(() => (ready = true))
  .catch((e) => {
    startError = String(e);
    logger.error({ err: startError }, 'chain start failed');
  });

const shutdown = async () => {
  server.close();
  await chain.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
