import { createServer } from 'node:http';
import { join } from 'node:path';
import { ROOT, UPLOAD_DIR } from './db.js';
import { Router } from './lib/router.js';
import {
  HttpError, sendJson, sendText, readJson, serveStatic, notFound,
} from './lib/http.js';
import { currentUser } from './lib/auth.js';
import { seedReference, seedDemo } from './seed.js';
import { startScheduler } from './lib/scheduler.js';

import registerCore from './api/core.js';
import registerLeads from './api/leads.js';
import registerWork from './api/work.js';
import registerReports from './api/reports.js';
import registerPublic from './api/public.js';

seedReference();
// Hosted deployments start with an empty disk — seed demo data so the URL is
// usable on first visit. seedDemo() is a no-op once any lead exists.
if (process.env.CRM_AUTO_SEED === '1') seedDemo(Number(process.env.CRM_DEMO_LEADS || 70));

const PUBLIC_DIR = join(ROOT, 'public');
const router = new Router();
registerPublic(router);
registerCore(router);
registerLeads(router);
registerWork(router);
registerReports(router);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    const route = router.match(req.method, pathname);
    if (route) {
      const needsBody = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
      const ctype = req.headers['content-type'] || '';
      const ctx = {
        req,
        res,
        url,
        query: Object.fromEntries(url.searchParams),
        params: route.params,
        body: needsBody && !ctype.includes('multipart/form-data') ? await readJson(req) : {},
        get user() {
          return currentUser(req);
        },
        ip: req.socket.remoteAddress,
      };
      const out = await route.handler(ctx);
      if (res.headersSent || res.writableEnded) return;
      sendJson(res, 200, out === undefined ? { ok: true } : out);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // uploaded documents
      if (pathname.startsWith('/files/')) {
        if (serveStatic(res, UPLOAD_DIR, pathname.slice('/files/'.length))) return;
        throw notFound();
      }
      if (serveStatic(res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname)) return;
      // SPA fallback (hash routing is used, but deep links should still work)
      if (!pathname.startsWith('/api/') && serveStatic(res, PUBLIC_DIR, 'index.html')) return;
    }
    throw notFound();
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, err);
    if (res.headersSent || res.writableEnded) return;
    if (pathname.startsWith('/api/') || (req.headers.accept || '').includes('application/json')) {
      sendJson(res, status, { error: err.message || 'server error', detail: err.detail ?? null });
    } else {
      sendText(res, status, err.message || 'server error');
    }
  }
});

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  startScheduler(Number(process.env.CRM_TICK_MS || 60000));
  console.log(`\n  CRM ready →  http://localhost:${PORT}`);
  console.log(`  login     →  admin@clinic.local / ${process.env.CRM_SEED_PASSWORD || '123456'}`);
  console.log(`  landing   →  http://localhost:${PORT}/demo/landing\n`);
});

export { server };
