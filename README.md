# code-to-figma

Capture shim + proxy server for the **[Code to Figma](https://github.com/pradyumna-ks/code-to-figma)** Figma plugin.

Two tools in one package:

| Tool | What it does | How to use |
|---|---|---|
| **Capture shim** | Lets the plugin read your running app's DOM and paste it as Figma layers | `npm i code-to-figma -D` + `import 'code-to-figma'` |
| **Proxy server** | Fetches any public website, strips iframe-blocking headers, injects the shim — perfect CSS/font/image rendering | `npx code-to-figma proxy` |

---

## 1. Capture shim (for your localhost app)

Install in your dev project so the plugin can read your running dev server:

```bash
npm install code-to-figma --save-dev
```

Then add to your entry file:

```ts
// src/main.tsx  (or index.ts / main.ts / _app.tsx)
import 'code-to-figma';
```

That's it. The shim listens for a capture request from the plugin and sends back the DOM tree. It does nothing otherwise.

### Dev-only guard (recommended)

```ts
if (import.meta.env.DEV || (typeof window !== 'undefined' && window.location.hostname === 'localhost')) {
  import('code-to-figma');
}
```

Webpack / CRA:

```ts
if (process.env.NODE_ENV === 'development' || (typeof window !== 'undefined' && window.location.hostname === 'localhost')) {
  import('code-to-figma');
}
```

### Next.js

```tsx
// app/layout.tsx
import Script from 'next/script';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        {process.env.NODE_ENV === 'development' && (
          <Script src="/figma-capture.js" strategy="afterInteractive" />
        )}
      </body>
    </html>
  );
}
```

---

## 2. Proxy server (for any public website)

Capture any public website—not just your localhost—with full CSS, custom fonts, and images.

```bash
npx code-to-figma proxy
```

Then in the Figma plugin, enter any URL. The plugin auto-detects the proxy and loads the page via `src` (not `srcdoc`), so the origin is localhost and everything works natively.

```
  ╔══════════════════════════════════════════╗
  ║        code-to-figma proxy active        ║
  ║                                          ║
  ║  http://localhost:3001                   ║
  ╚══════════════════════════════════════════╝

  Open the Code to Figma plugin in Figma and enter any URL.
  Cookies from your browser are forwarded to the target site.
  Press Ctrl+C to stop.
```

### How it works

```
Plugin iframe src ──▶ http://localhost:3001/?url=https://example.com
                             │
                             ▼
                       Proxy fetches the page (server-side)
                             │
                             ├─ Strips X-Frame-Options / CSP frame-ancestors
                             ├─ Adds <base> tag + capture shim
                             ├─ Forwards cookies from your browser
                             └─ Returns modified HTML with CORS headers
```

### Why use the proxy

| Feature | Jina Reader (built-in fallback) | Local proxy |
|---|---|---|
| CSS | ✅ Absolute URL rewrite needed | ✅ **Native** — loads from CDNs |
| Custom fonts | ❌ CORS blocked in srcdoc | ✅ **Native** — loads from CDNs |
| Images (canvas) | ⚠️ URL fallback in Figma sandbox | ✅ **Native** — no taint |
| SPAs (SSR sites) | ✅ Works (Next.js, Astro, etc.) | ✅ Works |
| Logged-in sites | ❌ No cookies | ✅ **Cookie forwarding** |
| User setup | Nothing | One terminal command |

### Options

```bash
npx code-to-figma proxy --port 8080    # Custom port (default: 3001)
npx code-to-figma proxy -p 8080        # Shorthand
```

---

## How the capture shim works

When the Code to Figma plugin clicks **Paste**, it sends a `postMessage` to your app. This shim receives it, walks the visible DOM, and returns a structured layer tree. The plugin uses that tree to create Figma nodes.

The shim is tree-shakeable when used with a dev-only dynamic import and adds no overhead to production builds.

---

## Component tagging (optional)

Tag elements you want promoted to Figma components:

```tsx
<Button data-component="Button/Primary">Save</Button>
```

Repeated `data-component` values become a Figma component + instances automatically.

---

## License

MIT — [Pradyumna KS](https://github.com/pradyumna-ks)
