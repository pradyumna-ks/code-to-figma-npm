#!/usr/bin/env node
'use strict';
/**
 * code-to-figma — postinstall
 *
 * Runs automatically after `npm install code-to-figma`.
 * Finds the project's entry file and inserts the capture shim import.
 *
 * Safe to run multiple times — skips if the import is already present.
 * Skipped entirely in CI environments (process.env.CI).
 */

const fs   = require('fs');
const path = require('path');

// ── ANSI colours ────────────────────────────────────────────
const g = (s) => `\x1b[32m${s}\x1b[0m`;  // green
const y = (s) => `\x1b[33m${s}\x1b[0m`;  // yellow
const b = (s) => `\x1b[36m${s}\x1b[0m`;  // blue/cyan
const d = (s) => `\x1b[2m${s}\x1b[0m`;   // dim

const PREFIX = b('[code-to-figma]');

// ── Guard: skip in CI / explicit opt-out ────────────────────
if (process.env.CI || process.env.SKIP_LTF_INSTALL || process.env.NODE_ENV === 'production') {
  console.log(`${PREFIX} ${d('CI/Production detected — skipping auto-setup')}`);
  process.exit(0);
}

// ── Project root: INIT_CWD = where `npm install` was run ────
// process.cwd() here is inside node_modules, not the project root.
const ROOT = process.env.INIT_CWD || process.cwd();

// ── Read user's package.json for framework detection ────────
let userPkg = {};
try {
  userPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch { /* no package.json — will try generic entry candidates */ }

const deps = { ...userPkg.dependencies, ...userPkg.devDependencies };

function hasDep(...names) {
  return names.some((n) => deps[n]);
}

const isNext   = hasDep('next');
const isNuxt   = hasDep('nuxt', '@nuxt/core');
const isRemix  = hasDep('@remix-run/react', '@remix-run/node', '@remix-run/dev');
const isSvelte = hasDep('svelte', '@sveltejs/kit');
const isVue    = hasDep('vue', '@vue/core');
const isAstro  = hasDep('astro');

// ── Import line + uniqueness marker ─────────────────────────
// Dev-guard: process.env.NODE_ENV is defined by every major bundler (Vite,
// webpack, Next.js, Remix). It gets statically replaced and the dead branch
// is tree-shaken away in production builds — zero cost in prod.
// `void` suppresses the floating-promise TS/eslint warning.
const IMPORT = "if (process.env.NODE_ENV === 'development' || (typeof window !== 'undefined' && window.location.hostname === 'localhost')) void import('code-to-figma');";
const MARKER = 'code-to-figma';   // presence check — works for require() too

// ── Entry file candidate lists ───────────────────────────────
const GENERIC = [
  'src/main.tsx','src/main.ts','src/main.jsx','src/main.js',
  'src/index.tsx','src/index.ts','src/index.jsx','src/index.js',
  'main.tsx','main.ts','main.jsx','main.js',
  'index.tsx','index.ts','index.jsx','index.js',
];

const NEXT_PAGES = [
  'pages/_app.tsx','pages/_app.ts','pages/_app.jsx','pages/_app.js',
];
// App Router layout.tsx is server component by default — unsafe to side-effect
// import there, so we prefer the pages router fallback or skip.

const REMIX_CANDIDATES = [
  'app/entry.client.tsx','app/entry.client.ts',
  'app/entry.client.jsx','app/entry.client.js',
];

const SVELTE_CANDIDATES = [
  'src/app.html',   // special handling — different insertion
  'src/hooks.client.ts','src/hooks.client.js',
];

// ── Find first existing file ─────────────────────────────────
function findFirst(candidates) {
  for (const rel of candidates) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) return { rel, full };
  }
  return null;
}

// ── Idempotency check ────────────────────────────────────────
function alreadyImported(content) {
  return content.includes(MARKER);
}

// ── Directive-aware prepend ──────────────────────────────────
// 'use client' / 'use server' must stay on line 1 — insert after them.
function insertImport(content) {
  const lines = content.split('\n');
  let insertAt = 0;

  // Skip past any 'use client' / 'use server' directives at the top
  while (
    insertAt < lines.length &&
    /^\s*['"]use (client|server)['"]\s*;?\s*$/.test(lines[insertAt])
  ) {
    insertAt++;
  }

  // If there's already content on that line, add a blank line separator
  const blank = lines[insertAt]?.trim() ? '' : null;
  const toInsert = blank !== null
    ? [IMPORT]
    : [IMPORT, ''];

  lines.splice(insertAt, 0, ...toInsert);
  return lines.join('\n');
}

// ── Handlers per framework ───────────────────────────────────

function handleGeneric(candidates, label) {
  const entry = findFirst(candidates);
  if (!entry) return false;

  const content = fs.readFileSync(entry.full, 'utf8');
  if (alreadyImported(content)) {
    console.log(`${PREFIX} ${g('✓')} Already set up in ${b(entry.rel)} — nothing to do`);
    return true;
  }

  fs.writeFileSync(entry.full, insertImport(content), 'utf8');
  console.log(`${PREFIX} ${g('✓')} Added shim import to ${b(entry.rel)}`);
  console.log(`${PREFIX}   ${d('Remove that line to uninstall the shim.')}`);
  return true;
}

function handleNext() {
  // Try pages/_app first — always client-side, safest place
  const pages = findFirst(NEXT_PAGES);
  if (pages) {
    const content = fs.readFileSync(pages.full, 'utf8');
    if (alreadyImported(content)) {
      console.log(`${PREFIX} ${g('✓')} Already set up in ${b(pages.rel)} — nothing to do`);
      return;
    }
    fs.writeFileSync(pages.full, insertImport(content), 'utf8');
    console.log(`${PREFIX} ${g('✓')} Added shim import to ${b(pages.rel)} (Next.js Pages Router)`);
    return;
  }

  // App Router detected but no pages/_app — print instructions; unsafe to auto-modify layout.tsx
  console.log(`${PREFIX} ${y('!')} Next.js App Router detected`);
  console.log(`${PREFIX}   Auto-insert not safe for server components.`);
  console.log(`${PREFIX}   Add this to a ${b("'use client'")} component (e.g. your root layout):`);
  console.log();
  console.log(`   ${d("// src/app/layout.tsx — after 'use client'")}`);
  console.log(`   ${g(IMPORT)}`);
  console.log();
}

function handleRemix() {
  if (!handleGeneric(REMIX_CANDIDATES, 'Remix')) {
    // fall back to generic src/
    handleGeneric(GENERIC, 'Remix (generic)');
  }
}

function handleSvelte() {
  // SvelteKit: prefer hooks.client.ts
  const hook = findFirst(['src/hooks.client.ts','src/hooks.client.js']);
  if (hook) {
    const content = fs.readFileSync(hook.full, 'utf8');
    if (alreadyImported(content)) {
      console.log(`${PREFIX} ${g('✓')} Already set up in ${b(hook.rel)} — nothing to do`);
      return;
    }
    fs.writeFileSync(hook.full, insertImport(content), 'utf8');
    console.log(`${PREFIX} ${g('✓')} Added shim import to ${b(hook.rel)} (SvelteKit client hook)`);
    return;
  }
  // Create hooks.client.ts if it doesn't exist
  const hookPath = path.join(ROOT, 'src/hooks.client.ts');
  if (fs.existsSync(path.join(ROOT, 'src'))) {
    fs.writeFileSync(hookPath, `${IMPORT}\n`, 'utf8');
    console.log(`${PREFIX} ${g('✓')} Created ${b('src/hooks.client.ts')} with shim import (SvelteKit)`);
    return;
  }
  handleGeneric(GENERIC, 'Svelte');
}

// ── Main ─────────────────────────────────────────────────────

console.log();
console.log(`${PREFIX} Setting up capture shim…`);

if      (isNext)   handleNext();
else if (isRemix)  handleRemix();
else if (isSvelte) handleSvelte();
else               handleGeneric(GENERIC, 'generic');

// Final nudge if nothing was auto-inserted
const anyFound = isNext
  ? findFirst(NEXT_PAGES)          // may be null (app router)
  : findFirst(isRemix ? REMIX_CANDIDATES : GENERIC);

if (!anyFound && !isNext) {
  console.log(`${PREFIX} ${y('!')} Could not find an entry file automatically.`);
  console.log(`${PREFIX}   Add manually to your app entry:`);
  console.log();
  console.log(`   ${g(IMPORT)}`);
  console.log();
  console.log(`${PREFIX}   ${d('Common locations: src/main.tsx, src/index.tsx, src/main.js')}`);
}

console.log();
