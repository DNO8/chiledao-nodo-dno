import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { worksAssetCopies } from './fixtures/works-assets.mjs';

// Explicit local check only; the normal homepage suite never needs this archive.
const artworkRoot = process.env.CHILEDAO_ARTWORK_ROOT
  ?? fileURLToPath(new URL('../../ChileDAO_ Diseño - Gráficas/', import.meta.url));
let missingArchive = false;
try {
  assert.ok(statSync(artworkRoot).isDirectory(), 'artwork archive root must be a directory');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  missingArchive = true;
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
for (const [source, destination, expected] of worksAssetCopies) {
  test(`local original integrity: ${source}`, {
    skip: missingArchive ? `N/A: optional artwork archive not found at ${artworkRoot}` : false,
  }, () => {
    // Missing/changed selected files in an existing archive must fail, not skip.
    const original = readFileSync(join(artworkRoot, source));
    const copy = readFileSync(new URL(`../${destination}`, import.meta.url));
    assert.equal(hash(original), expected, `unchanged original ${source}`);
    assert.equal(hash(copy), expected, `copied ${destination}`);
    assert.ok(copy.equals(original), `identical original/copy bytes: ${destination}`);
  });
}
