/**
 * Regression tests for the post-audit hardening batch (no network, no spend):
 *  - error-classifier: non-Anthropic context-overflow strings → context_limit
 *  - image budget: caller-resolved cost closes the static-table $0 bypass
 *  - atomic persistence: in-place swap, .bak snapshot, .bak recovery on corruption
 */
process.env.FRANKLIN_NO_AUDIT = '1';
process.env.FRANKLIN_NO_PERSIST = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── error-classifier: context-limit wire strings ──────────────────────────
test('classifyAgentError maps non-Anthropic context-overflow strings to context_limit', async () => {
  const { classifyAgentError } = await import('../dist/agent/error-classifier.js');
  for (const msg of [
    "context_length_exceeded: This model's maximum context length is 128000 tokens",
    'Input exceeds the context window for this model',
    'context_window exceeded',
  ]) {
    assert.equal(classifyAgentError(msg).category, 'context_limit', `"${msg}" should be context_limit`);
  }
});

// ── image budget bypass: caller-resolved cost enforces the cap ─────────────
test('checkImageBudget enforces the caller-resolved cost for a model absent from the static table', async () => {
  const { ContentLibrary } = await import('../dist/content/library.js');
  const { checkImageBudget } = await import('../dist/content/record-image.js');
  const lib = new ContentLibrary();
  const c = lib.create({ type: 'blog', title: 'x', budgetUsd: 0.03 });
  // 'xai/grok-imagine-image-pro' is NOT in the static PRICE_TABLE → the static
  // estimate is $0 and would wrongly greenlight (documents the bypass).
  const noOverride = checkImageBudget(lib, c.id, 'xai/grok-imagine-image-pro', '1024x1024');
  assert.equal(noOverride.ok, true, 'static table returns $0 for an unlisted model — the gap');
  // With the caller-resolved $0.07 (from the live catalog) it must refuse.
  const withOverride = checkImageBudget(lib, c.id, 'xai/grok-imagine-image-pro', '1024x1024', 1, 0.07);
  assert.equal(withOverride.ok, false, 'caller-resolved cost must enforce the budget cap');
});

test('recordImageAsset books the caller-resolved cost, not the $0 static estimate', async () => {
  const { ContentLibrary } = await import('../dist/content/library.js');
  const { recordImageAsset } = await import('../dist/content/record-image.js');
  const lib = new ContentLibrary();
  const c = lib.create({ type: 'blog', title: 'Hero', budgetUsd: 1 });
  const dec = recordImageAsset(lib, {
    contentId: c.id, imagePath: '/tmp/h.png',
    model: 'xai/grok-imagine-image-pro', size: '1024x1024', costUsd: 0.07,
  });
  assert.equal(dec.ok, true);
  assert.equal(dec.costUsd, 0.07);
  assert.equal(lib.get(c.id).spentUsd, 0.07, 'real spend booked against the budget');
});

// ── atomic persistence ────────────────────────────────────────────────────
test('atomicWriteFileSync swaps in place, keeps a .bak, leaves no .tmp', async () => {
  const { atomicWriteFileSync } = await import('../dist/storage/atomic.js');
  const dir = mkdtempSync(join(tmpdir(), 'fr-atomic-'));
  try {
    const f = join(dir, 'data.json');
    atomicWriteFileSync(f, 'A');
    assert.equal(readFileSync(f, 'utf8'), 'A');
    assert.equal(existsSync(`${f}.bak`), false, 'first write makes no .bak');
    atomicWriteFileSync(f, 'B');
    assert.equal(readFileSync(f, 'utf8'), 'B');
    assert.equal(readFileSync(`${f}.bak`, 'utf8'), 'A', 'previous good copy preserved as .bak');
    assert.equal(existsSync(`${f}.tmp`), false, 'no temp file left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadLibrary recovers from .bak when the live file is corrupt', async () => {
  const { ContentLibrary } = await import('../dist/content/library.js');
  const { saveLibrary, loadLibrary } = await import('../dist/content/store.js');
  const dir = mkdtempSync(join(tmpdir(), 'fr-lib-'));
  try {
    const f = join(dir, 'library.json');
    const v1 = new ContentLibrary(); v1.create({ type: 'blog', title: 'one', budgetUsd: 1 });
    saveLibrary(v1, f);                       // file = v1, no .bak yet
    const v2 = new ContentLibrary();
    v2.create({ type: 'blog', title: 'one', budgetUsd: 1 });
    v2.create({ type: 'blog', title: 'two', budgetUsd: 1 });
    saveLibrary(v2, f);                        // file = v2, .bak = v1
    writeFileSync(f, '{ corrupt json', 'utf8'); // simulate a torn write
    const loaded = loadLibrary(f);
    assert.ok(loaded, 'should recover from .bak rather than return null');
    assert.equal(loaded.list().length, 1, 'recovered the last good (v1) snapshot');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadPortfolio recovers from .bak when the live file is corrupt', async () => {
  const { Portfolio } = await import('../dist/trading/portfolio.js');
  const { savePortfolio, loadPortfolio } = await import('../dist/trading/store.js');
  const dir = mkdtempSync(join(tmpdir(), 'fr-pf-'));
  try {
    const f = join(dir, 'portfolio.json');
    const pf = new Portfolio({ startingCashUsd: 1000 });
    savePortfolio(pf, f);   // file, no .bak
    savePortfolio(pf, f);   // .bak now holds a valid snapshot
    writeFileSync(f, 'not json', 'utf8');
    const loaded = loadPortfolio(f);
    assert.ok(loaded, 'should recover the portfolio from .bak rather than zeroing P&L');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
