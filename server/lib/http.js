import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
export const bad = (msg, detail) => new HttpError(400, msg, detail);
export const unauthorized = (msg = 'not authenticated') => new HttpError(401, msg);
export const forbidden = (msg = 'not allowed') => new HttpError(403, msg);
export const notFound = (msg = 'not found') => new HttpError(404, msg);

export function sendJson(res, status, data) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

export function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

const MAX_BODY = 25 * 1024 * 1024; // 25MB — covers document uploads

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw bad('invalid JSON body');
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge != null) bits.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
export const mimeFor = (p) => MIME[extname(p).toLowerCase()] || 'application/octet-stream';

export function serveStatic(res, rootDir, urlPath, { download = null, cache = 'no-cache' } = {}) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\.])+/, '');
  const file = join(rootDir, rel);
  if (!file.startsWith(rootDir) || !existsSync(file)) return false;
  const st = statSync(file);
  if (!st.isFile()) return false;
  const headers = {
    'Content-Type': mimeFor(file),
    'Content-Length': st.size,
    'Cache-Control': cache,
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Minimal multipart/form-data parser (enough for single/multi file uploads).
 * Returns { fields: {}, files: [{ field, filename, mime, data }] }
 */
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw bad('missing multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {};
  const files = [];
  let pos = buffer.indexOf(boundary);
  if (pos < 0) throw bad('malformed multipart body');
  pos += boundary.length;
  while (pos < buffer.length) {
    if (buffer.slice(pos, pos + 2).toString() === '--') break;
    pos += 2; // skip CRLF
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const rawHeaders = buffer.slice(pos, headerEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headerEnd);
    const dataEnd = next < 0 ? buffer.length : next - 2;
    const data = buffer.slice(headerEnd + 4, dataEnd);

    const nameM = /name="([^"]*)"/i.exec(rawHeaders);
    const fileM = /filename="([^"]*)"/i.exec(rawHeaders);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);
    const field = nameM ? nameM[1] : 'field';
    if (fileM && fileM[1]) {
      files.push({ field, filename: fileM[1], mime: typeM ? typeM[1].trim() : 'application/octet-stream', data });
    } else {
      fields[field] = data.toString('utf8');
    }
    if (next < 0) break;
    pos = next + boundary.length;
  }
  return { fields, files };
}
