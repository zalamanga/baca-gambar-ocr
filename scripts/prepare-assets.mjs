import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRealPath = await realpath(projectRoot);
const lock = JSON.parse(await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const fixtureManifest = JSON.parse(await readFile(path.join(projectRoot, 'tests/fixtures/manifest.json'), 'utf8'));
const versions = {
  'tesseract.js': '7.0.0',
  'tesseract.js-core': '7.0.0',
  '@tesseract.js-data/eng': '1.0.0',
  '@tesseract.js-data/ind': '1.0.0',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const withinProject = (target) => {
  const relative = path.relative(projectRealPath, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

async function safeOutput(relativePath) {
  const target = path.resolve(projectRoot, relativePath);
  if (!withinProject(target)) throw new Error(`Invalid output path: ${relativePath}`);
  let ancestor = target;
  while (ancestor !== projectRoot) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Generated output must not use symlinks: ${relativePath}`);
      if (!withinProject(await realpath(ancestor))) throw new Error(`Output points outside the project: ${relativePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Invalid output ancestor: ${relativePath}`);
    ancestor = parent;
  }
  await mkdir(path.dirname(target), { recursive: true });
  return target;
}

const packages = {};
for (const [name, expectedVersion] of Object.entries(versions)) {
  const sourceRoot = path.join(projectRoot, 'node_modules', name);
  const metadata = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (metadata.version !== expectedVersion || lock.packages[`node_modules/${name}`]?.version !== expectedVersion) {
    throw new Error(`${name} must match locked version ${expectedVersion}. Run npm ci before building.`);
  }
  packages[name] = { version: metadata.version, license: metadata.license, repository: metadata.repository };
}

const assets = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'public/ocr/worker/worker.min.js'],
  ['node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt', 'public/ocr/worker/worker.min.js.LICENSE.txt'],
  ['node_modules/tesseract.js/LICENSE.md', 'public/ocr/licenses/tesseract.js-LICENSE.md'],
  ['node_modules/tesseract.js-core/LICENSE', 'public/ocr/licenses/tesseract.js-core-LICENSE.txt'],
];

for (const stem of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  for (const extension of ['.js', '.wasm', '.wasm.js']) {
    const filename = `${stem}${extension}`;
    assets.push([`node_modules/tesseract.js-core/${filename}`, `public/ocr/core/${filename}`]);
  }
}
for (const language of ['eng', 'ind']) {
  assets.push([
    `node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,
    `public/ocr/lang/${language}.traineddata`,
    'gunzip',
  ]);
}
for (const filename of ['indonesian-receipt.png', 'english-note.jpg']) {
  assets.push([`tests/fixtures/${filename}`, `public/examples/${filename}`]);
}

const entries = await Promise.all(assets.map(async ([source, destination, transformation]) => {
  const sourcePath = path.join(projectRoot, source);
  const sourceBytes = await readFile(sourcePath);
  if (!sourceBytes.length) throw new Error(`Empty asset: ${source}. Wait for npm ci to finish.`);
  if (source.endsWith('.wasm') && sourceBytes.subarray(0, 4).toString() !== '\0asm') {
    throw new Error(`Invalid WebAssembly asset: ${source}`);
  }
  if (source.endsWith('.gz') && (sourceBytes[0] !== 0x1f || sourceBytes[1] !== 0x8b)) {
    throw new Error(`Invalid compressed model: ${source}`);
  }
  const bytes = transformation === 'gunzip' ? gunzipSync(sourceBytes) : sourceBytes;
  const hash = sha256(bytes);
  if (source.startsWith('tests/fixtures/')) {
    const fixture = fixtureManifest.cases.find((item) => item.file === path.basename(source));
    if (!fixture || fixture.sha256 !== hash) throw new Error(`Fixture checksum differs from its manifest: ${source}`);
  }
  const targetPath = await safeOutput(destination);
  if (transformation) await writeFile(targetPath, bytes);
  else await copyFile(sourcePath, targetPath);
  return {
    source,
    ...(transformation ? { transformation, sourceBytes: sourceBytes.length, sourceSha256: sha256(sourceBytes) } : {}),
    url: destination.replace(/^public\//, ''),
    bytes: bytes.length,
    sha256: hash,
  };
}));

for (const language of ['eng', 'ind']) {
  const obsoletePath = await safeOutput(`public/ocr/lang/${language}.traineddata.gz`);
  try {
    await unlink(obsoletePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const manifestPath = await safeOutput('public/ocr/asset-manifest.json');
await writeFile(manifestPath, `${JSON.stringify({ schema: 1, packages, files: entries }, null, 2)}\n`, 'utf8');
const totalBytes = entries.reduce((sum, file) => sum + file.bytes, 0);
console.log(`Prepared ${entries.length} local assets (${(totalBytes / 1024 / 1024).toFixed(1)} MiB); OCR runtime needs no CDN.`);
