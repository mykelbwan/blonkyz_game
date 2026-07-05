const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { handleApi } = require('./lib/api-handler');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  const publicRoot = path.join(ROOT, 'public');
  const candidates = pathname === '/'
    ? [path.join(publicRoot, 'index.html')]
    : [path.join(publicRoot, pathname), path.join(ROOT, pathname)];

  try {
    let normalized = null;
    let data = null;
    for (const candidate of candidates) {
      const next = path.normalize(candidate);
      if (!next.startsWith(publicRoot) && !next.startsWith(ROOT)) return text(res, 403, 'Forbidden');
      try {
        data = await fs.readFile(next);
        normalized = next;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!data) return text(res, 404, 'Not found');

    const ext = path.extname(normalized).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') return text(res, 404, 'Not found');
    console.error(error);
    return text(res, 500, 'Server error');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  return serveStatic(req, res, decodeURIComponent(url.pathname));
});

server.listen(PORT, () => {
  console.log(`Blonkyz Runner server running at http://localhost:${PORT}`);
});
