// Local UI preview only. Illustrator operations require the CEP host.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  if (name === '/') name = '/index.html';
  if (!/^\/(index\.html|js\/[a-zA-Z0-9.-]+\.js|css\/[a-zA-Z0-9.-]+\.css)$/.test(name)) { res.writeHead(404).end(); return; }
  fs.readFile(path.join(root, name), (error, body) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type':types[path.extname(name)],'Cache-Control':'no-store'}).end(body);
  });
}).listen(8217, '127.0.0.1', () => process.stdout.write('UI preview: http://127.0.0.1:8217\n'));
