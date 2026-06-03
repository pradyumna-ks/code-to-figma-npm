#!/usr/bin/env node
'use strict';
/**
 * web-to-figma proxy
 *
 * A lightweight HTTP proxy that fetches any public website, strips response
 * headers that block iframe embedding (X-Frame-Options, CSP frame-ancestors),
 * injects the capture shim, and returns the modified HTML.
 *
 * Usage:  npx web-to-figma proxy
 *         npx web-to-figma proxy --port 8080
 *
 * The plugin auto-detects this proxy at http://localhost:3001. When it's
 * running, the iframe loads via src (not srcdoc), so the origin is localhost
 * and CSS, fonts, images all load natively from CDNs without CORS issues.
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 3001;
const TIMEOUT_MS = 30_000;

// ── Read the capture shim from the same package ─────────────
const SHIM_PATH = path.join(__dirname, 'figma-capture.js');
let SHIM_SOURCE = '';
try {
  SHIM_SOURCE = fs.readFileSync(SHIM_PATH, 'utf8');
} catch (err) {
  console.error('[web-to-figma] ERROR: Could not read figma-capture.js');
  console.error('[web-to-figma] Make sure it exists next to proxy-server.js');
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
      // 'proxy' subcommand — already handled by bin name
      continue;
    }
  }
  return { port };
}

// ── Fetch a URL with redirect following ──────────────────────
function fetchUrl(targetUrl, cookies) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    // Forward cookies from the iframe browser to the target site
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
      // Follow up to 5 redirects
      maxRedirects: 5,
    };

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body.toString('utf8'),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ── Modify HTML for iframe embedding ─────────────────────────
function processHtml(html, originalUrl) {
  const escapedUrl = originalUrl.replace(/"/g, '&quot;');

  // Strip CSP that blocks frames
  let cleaned = html.replace(
    /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
    ''
  );

  // Add <base> tag so relative URLs resolve against the original page
  const baseTag = `<base href="${escapedUrl}">`;

  // Inject shim + base tag
  if (cleaned.includes('</head>')) {
    // Base first in head, then rest, then shim at end of head
    cleaned = cleaned
      .replace('<head>', `<head>\n${baseTag}`)
      .replace('</head>', `<script>${SHIM_SOURCE}</script>\n</head>`);
  } else if (cleaned.includes('<html')) {
    const idx = cleaned.indexOf('>') + 1;
    cleaned = cleaned.slice(0, idx) + `<head>${baseTag}<script>${SHIM_SOURCE}</script></head>` + cleaned.slice(idx);
  } else {
    cleaned = `<head>${baseTag}<script>${SHIM_SOURCE}</script></head>${cleaned}`;
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
function stripBlockingHeaders(headers) {
  const result = { ...headers };
  delete result['x-frame-options'];
  delete result['x-xss-protection'];
  // Remove frame-ancestors from CSP
  if (result['content-security-policy']) {
    result['content-security-policy'] = result['content-security-policy']
      .replace(/;?\s*frame-ancestors\s[^;]+/gi, '');
  }
  if (result['content-security-policy-report-only']) {
    result['content-security-policy-report-only'] = result['content-security-policy-report-only']
      .replace(/;?\s*frame-ancestors\s[^;]+/gi, '');
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
      res.end(JSON.stringify({ status: 'ok', service: 'web-to-figma-proxy' }));
      return;
    }

    // Parse the target URL from query params
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

    console.log(`[web-to-figma] Proxying: ${targetUrl}`);

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

      // Inject shim and fix headers
      const modified = processHtml(result.body, targetUrl);
      const responseHeaders = stripBlockingHeaders(result.headers);
      responseHeaders['Content-Type'] = 'text/html; charset=utf-8';

      res.writeHead(result.status, responseHeaders);
      res.end(modified);

      console.log(`[web-to-figma] ✓ ${targetUrl} — ${result.status}${result.headers['set-cookie'] ? ' (cookies set)' : ''}`);
    } catch (err) {
      console.error(`[web-to-figma] ✗ ${targetUrl} — ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, () => {
    console.log('');
    console.log(`  ╔══════════════════════════════════════════╗`);
    console.log(`  ║        web-to-figma proxy active         ║`);
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
