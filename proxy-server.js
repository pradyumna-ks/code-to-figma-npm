#!/usr/bin/env node
'use strict';

// ═══ QUICK FLAGS CHECK ═══════════════════════════════════
// Must be at the VERY TOP — before any require or processing.
// npx may swallow arguments in some versions, so check raw process.argv.
const _rawArgs = process.argv.slice(2).join(' ');
if (_rawArgs.includes('--version') || _rawArgs.includes('-v')) {
  // eslint-disable-next-line no-var, no-undef
  var _pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'package.json'), 'utf8'));
  console.log(_pkg.version);
  process.exit(0);
}
if (_rawArgs.includes('--help') || _rawArgs.includes('-h')) {
  console.log('');
  console.log('  code-to-figma proxy server');
  console.log('');
  console.log('    npx code-to-figma proxy           Start proxy (default port 3001)');
  console.log('    npx code-to-figma proxy -p 8080    Custom port');
  console.log('    npx code-to-figma --version       Show version');
  console.log('    npx code-to-figma --help          Show this help');
  console.log('');
  process.exit(0);
}
// ════════════════════════════════════════════════════════
/**
 * code-to-figma proxy
 *
 * A lightweight HTTP proxy that fetches any public website, strips response
 * headers that block iframe embedding (X-Frame-Options, CSP frame-ancestors),
 * injects the capture shim, and returns the modified HTML.
 *
 * Usage:  npx code-to-figma proxy
 *         npx code-to-figma proxy --port 8080
 *
 * The plugin auto-detects this proxy at http://localhost:3001. When it's
 * running, the iframe loads via src (not srcdoc), so the origin is localhost
 * and CSS, fonts, images all load natively from CDNs without CORS issues.
 *
 * Cookie forwarding:
 *   The proxy reads cookies from the incoming request (your browser stores
 *   cookies for localhost:3001) and forwards them to the target site via
 *   the Cookie header. Set-Cookie responses from the target are passed back
 *   to your browser. This enables session persistence across navigations.
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 3001;
const TIMEOUT_MS = 30_000;

// ── Asset cache (LRU) and concurrency limiter ───────────────
// Prevents OOM on image-heavy pages by limiting concurrent fetches
// and caching recently-used assets.
const MAX_CACHE_SIZE = 200;
const MAX_CONCURRENT_FETCHES = 10;
const assetCache = new Map();        // url → { body, headers, storedAt }
let activeFetches = 0;
const fetchQueue = [];               // [{ url, resolve, reject }]

function processQueue() {
  while (fetchQueue.length > 0 && activeFetches < MAX_CONCURRENT_FETCHES) {
    const { url, resolve, reject } = fetchQueue.shift();
    activeFetches++;
    doFetchAsset(url).then(resolve, reject).finally(() => {
      activeFetches--;
      processQueue();
    });
  }
}

function enqueueAssetFetch(url) {
  return new Promise((resolve, reject) => {
    fetchQueue.push({ url, resolve, reject });
    processQueue();
  });
}

async function doFetchAsset(url) {
  // Check cache first
  const cached = assetCache.get(url);
  if (cached && Date.now() - cached.storedAt < 60_000) {
    return { body: cached.body, headers: cached.headers };
  }
  const result = await fetchUrl(url);
  const body = result.body;
  const headers = result.headers;
  // Store in cache (evict oldest if full)
  if (assetCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = assetCache.keys().next().value;
    assetCache.delete(oldestKey);
  }
  assetCache.set(url, { body, headers, storedAt: Date.now() });
  return { body, headers };
}

// ── Read the capture shim from the same package ─────────────
const SHIM_PATH = path.join(__dirname, 'figma-capture.js');
let SHIM_SOURCE = '';
try {
  SHIM_SOURCE = fs.readFileSync(SHIM_PATH, 'utf8');
} catch (err) {
  console.error('[code-to-figma] ERROR: Could not read figma-capture.js');
  console.error('[code-to-figma] Make sure it exists next to proxy-server.js');
  process.exit(1);
}

// ── Arguments ───────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) port = DEFAULT_PORT;
      i++;
    } else if (args[i] === 'proxy') {
      continue;
    }
  }
  return { port };
}

// ── Fetch a URL with redirect following (returns buffer for binary) ──
// Node.js http/https does NOT follow redirects automatically — we must
// do it manually. Also handles protocol switches (http→https).
function fetchUrl(targetUrl, cookies, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects: ' + targetUrl));
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    if (cookies) {
      requestHeaders['Cookie'] = cookies;
    }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: requestHeaders,
      timeout: TIMEOUT_MS,
      rejectUnauthorized: false, // Allow self-signed certs on some sites
    };

    const req = mod.request(options, (res) => {
      // Handle redirects manually — Node.js http/https does NOT follow them
      const status = res.statusCode;
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without Location header'));
        // Resolve relative redirect URLs
        const redirectUrl = new URL(location, targetUrl).href;
        return resolve(fetchUrl(redirectUrl, cookies, redirectCount + 1));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status,
          headers: res.headers,
          body,   // Buffer (binary-safe, not string)
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ── Rewrite image URLs in HTML to go through proxy ──────────
// Makes all <img src> and CSS url() resolve through localhost,
// so canvas.drawImage() doesn't taint (same-origin).
function rewriteImageUrlsToProxy(html, proxyBase, originalUrl) {
  const proxyAssetUrl = (srcUrl) => {
    try {
      const abs = new URL(srcUrl, originalUrl).href;
      return `${proxyBase}/proxy-asset?url=${encodeURIComponent(abs)}`;
    } catch {
      return srcUrl;
    }
  };

  // Rewrite <img src> and <img srcset>
  let result = html.replace(
    /(<img\s[^>]*?src\s*=\s*")([^"]+)(")/gi,
    (match, before, src, after) => before + proxyAssetUrl(src) + after
  );
  result = result.replace(
    /(<img\s[^>]*?src\s*=\s*')([^']+)(')/gi,
    (match, before, src, after) => before + proxyAssetUrl(src) + after
  );

  // Rewrite <source> in <picture> elements (responsive images)
  result = result.replace(
    /(<source\s[^>]*?srcset\s*=\s*")([^"]+)(")/gi,
    (match, before, srcset, after) => {
      const newSrcset = srcset.replace(/(\S+)(\s+\d+[wx]\b)?/g, (m, urlPart, descriptor) => {
        if (urlPart.startsWith('data:') || urlPart.startsWith('blob:')) return m;
        return proxyAssetUrl(urlPart) + (descriptor || '');
      });
      return before + newSrcset + after;
    }
  );

  // Rewrite <source> src for picture elements
  result = result.replace(
    /(<source\s[^>]*?src\s*=\s*")([^"]+)(")/gi,
    (match, before, src, after) => before + proxyAssetUrl(src) + after
  );

  // Rewrite srcset URLs (format: "url width, url width, ...")
  result = result.replace(
    /(<(?:img|source)\s[^>]*?srcset\s*=\s*")([^"]+)(")/gi,
    (match, before, srcset, after) => {
      const newSrcset = srcset.replace(/(\S+)(\s+\d+[wx]\b)?/g, (m, urlPart, descriptor) => {
        return proxyAssetUrl(urlPart) + (descriptor || '');
      });
      return before + newSrcset + after;
    }
  );

  // Rewrite CSS url() in inline styles and style tags
  result = result.replace(
    /url\(['"]?([^'")\s]+)['"]?\)/gi,
    (match, cssUrl) => {
      if (cssUrl.startsWith('data:') || cssUrl.startsWith('blob:') || cssUrl.startsWith('#')) return match;
      return `url('${proxyAssetUrl(cssUrl)}')`;
    }
  );

  return result;
}

// ── Modify HTML for iframe embedding ─────────────────────────
function processHtml(html, originalUrl, proxyBase) {
  const escapedUrl = originalUrl.replace(/"/g, '&quot;');

  // Strip CSP that blocks frames
  let cleaned = html.replace(
    /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
    ''
  );

  // Rewrite all image/asset URLs to go through proxy for same-origin canvas
  cleaned = rewriteImageUrlsToProxy(cleaned, proxyBase, originalUrl);

  // Add <base> tag so relative URLs resolve against the original page
  const baseTag = `<base href="${escapedUrl}">`;

  // Frame-busting bypass — patches window.top/parent BEFORE any page JS runs.
  // Many SPAs (Claude, Stripe, etc.) check `window.top !== window.self` and
  // throw an error if loaded in an iframe. This script runs before the page's
  // own scripts so the checks pass.
  const frameBustPatch = `<script>
(function(){
  // Block frame-busting by making window.top and window.parent point to self.
  var patch = function() {
    try {
      Object.defineProperty(window, 'top', { value: window, configurable: false, writable: false });
      Object.defineProperty(window, 'parent', { value: window, configurable: false, writable: false });
      Object.defineProperty(window, 'frameElement', { value: null, configurable: false, writable: false });
    } catch(e) {}
    // Block postMessage-based frame detection (e.g. Claude)
    var _origPM = window.postMessage;
    window.postMessage = function(msg, target, transfer) {
      // Allow DEV_TO_DESIGN messages through, silently drop the rest
      if (msg && msg.type && msg.type.indexOf('DEV_TO_DESIGN') === 0) {
        return _origPM.call(window, msg, target, transfer);
      }
      return undefined;
    };
    window.name = '';
  };
  patch();
  // Re-patch on DOMContentLoaded and after a delay to catch SPAs that check
  // asynchronously.
  document.addEventListener('DOMContentLoaded', patch);
  setTimeout(patch, 500);
  setTimeout(patch, 2000);
})();
<\/script>`;

  // Inject base tag + frame-bust patch + shim
  if (cleaned.includes('</head>')) {
    // Base first in head, then frame-bust patch, then shim at end of head
    cleaned = cleaned
      .replace('<head>', `<head>\n${baseTag}`)
      .replace('</head>', `${frameBustPatch}<script>${SHIM_SOURCE}</script>\n</head>`);
  } else if (cleaned.includes('<html')) {
    const idx = cleaned.indexOf('>') + 1;
    cleaned = cleaned.slice(0, idx) + `<head>${baseTag}${frameBustPatch}<script>${SHIM_SOURCE}</script></head>` + cleaned.slice(idx);
  } else {
    cleaned = `<head>${baseTag}${frameBustPatch}<script>${SHIM_SOURCE}</script></head>${cleaned}`;
  }

  // Intercept link clicks to navigate inside the plugin
  cleaned = cleaned.replace('</body>', `<script>
(function(){
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') ||
        href.startsWith('mailto:') || href.startsWith('tel:')) return;
    e.preventDefault();
    var resolved = new URL(href, ${JSON.stringify(originalUrl)}).href;
    try { parent.postMessage({ type: 'DEV_TO_DESIGN/NAVIGATE_LINK', href: resolved }, '*'); } catch(e) {}
  }, true);
})();
<\/script>
</body>`);

  return cleaned;
}

// ── Strip iframe-blocking headers ────────────────────────────
// For HTML pages, we remove CSP entirely (not just frame-ancestors)
// because the page's CSP likely doesn't whitelist our injected shim
// as an inline script. Also strips frame-breaker headers.
function stripBlockingHeaders(headers, isHtml) {
  const result = { ...headers };
  delete result['x-frame-options'];
  delete result['x-xss-protection'];
  // For HTML pages, strip CSP entirely — we inject scripts so CSP
  // integrity is already broken. For assets (images/fonts), keep CSP.
  if (isHtml) {
    delete result['content-security-policy'];
    delete result['content-security-policy-report-only'];
  } else {
    // For non-HTML, only remove frame-ancestors
    if (result['content-security-policy']) {
      result['content-security-policy'] = result['content-security-policy']
        .replace(/;?\s*frame-ancestors\s[^;]+/gi, '');
    }
    if (result['content-security-policy-report-only']) {
      result['content-security-policy-report-only'] = result['content-security-policy-report-only']
        .replace(/;?\s*frame-ancestors\s[^;]+/gi, '');
    }
  }
  // Set CORS so the plugin can access the iframe content
  result['access-control-allow-origin'] = '*';
  return result;
}

// ── HTTP server ──────────────────────────────────────────────
function startServer(port) {
  const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end();
      return;
    }

    // Health check / ping endpoint
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ status: 'ok', service: 'code-to-figma-proxy' }));
      return;
    }

    // ── Asset proxy endpoint ───────────────────────────────
    // Rewritten <img src> and CSS url() go here.
    // The proxy fetches the asset from the original URL and returns it
    // with CORS headers. Since the page is served from the same origin
    // (localhost:3001), canvas.drawImage() does NOT taint.
    const parsedUrl = url.parse(req.url, true);
    if (parsedUrl.pathname === '/proxy-asset') {
      const assetUrl = parsedUrl.query.url;
      if (!assetUrl) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('Missing ?url');
        return;
      }
      try {
        const result = await enqueueAssetFetch(assetUrl);
        const responseHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000',
          'Content-Type': result.headers['content-type'] || 'application/octet-stream',
        };
        res.writeHead(200, responseHeaders);
        res.end(result.body);
      } catch (err) {
        console.error(`[code-to-figma] asset fetch failed: ${assetUrl} — ${err.message}`);
        // Return a transparent 1x1 GIF instead of crashing
        const transparentGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(transparentGif);
      }
      return;
    }

    // ── Page proxy endpoint ────────────────────────────────
    const parsed = url.parse(req.url, true);
    const targetUrl = parsed.query.url;

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing ?url query parameter' }));
      return;
    }

    // Validate URL
    let validUrl;
    try {
      validUrl = new URL(targetUrl);
      if (!validUrl.protocol.startsWith('http')) throw new Error('Not HTTP');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Invalid URL. Must be http:// or https://' }));
      return;
    }

    console.log(`[code-to-figma] Proxying: ${targetUrl}`);

    // Forward cookies from the iframe browser to the target
    // The browser stores cookies for localhost:3001 (our proxy domain)
    // and sends them on every request. We forward them to the target site,
    // and return Set-Cookie headers from the target back to the browser.
    const incomingCookies = req.headers['cookie'] || '';

    try {
      const result = await fetchUrl(targetUrl, incomingCookies);

      // Only process HTML responses
      const contentType = result.headers['content-type'] || '';
      if (!contentType.includes('text/html')) {
        // Pass through non-HTML responses as-is (images, fonts, etc.)
        res.writeHead(result.status, stripBlockingHeaders(result.headers));
        res.end(result.body);
        return;
      }

      // Inject shim, rewrite images, fix headers
      const html = result.body.toString('utf8');
      const proxyBase = `http://localhost:${server.address().port}`;
      const modified = processHtml(html, targetUrl, proxyBase);
      const responseHeaders = stripBlockingHeaders(result.headers, true);
      responseHeaders['Content-Type'] = 'text/html; charset=utf-8';

      res.writeHead(result.status, responseHeaders);
      res.end(modified);

      console.log(`[code-to-figma] ✓ ${targetUrl} — ${result.status}${result.headers['set-cookie'] ? ' (cookies set)' : ''}`);
    } catch (err) {
      console.error(`[code-to-figma] ✗ ${targetUrl} — ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, () => {
    console.log('');
    console.log(`  ╔══════════════════════════════════════════╗`);
    console.log(`  ║        code-to-figma proxy active        ║`);
    console.log(`  ║                                          ║`);
    console.log(`  ║  ${`http://localhost:${port}`.padEnd(38)}║`);
    console.log(`  ╚══════════════════════════════════════════╝`);
    console.log('');
    console.log('  Open the Code to Figma plugin in Figma and enter any URL.');
    console.log('  Cookies from your browser are forwarded to the target site.');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });
}

// ── Main ─────────────────────────────────────────────────────
const { port } = parseArgs();
startServer(port);
