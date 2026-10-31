import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixtureRoot = new URL('../fixtures/', import.meta.url);
const screenshotRoot = new URL('../../docs/screenshots/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', fixtureRoot), 'utf8'));
const fixtures = new Map(manifest.cases.map((fixture) => [fixture.id, fixture]));
const traffic = new WeakMap();

function fixturePath(id) {
  return fileURLToPath(new URL(fixtures.get(id).file, fixtureRoot));
}

function normalized(text) {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

async function upload(page, id) {
  const fixture = fixtures.get(id);
  await page.locator('#imageInput').setInputFiles(fixturePath(id));
  await expect(page.locator('#fileName')).toHaveText(fixture.file);
  await expect(page.locator('#readButton')).toBeEnabled();
  await expect(page.locator('#errorBox')).toBeHidden();
}

async function recognize(page, id, language = 'eng') {
  const fixture = fixtures.get(id);
  await page.locator('#language').selectOption(language);
  await page.locator('#readButton').click();
  await finished(page, fixture.expectEmpty ? 'Tidak ada teks' : 'Siap diedit');
  await expect(page.locator('#readButton')).toBeEnabled();
  const text = await page.locator('#output').inputValue();
  if (fixture.expectEmpty) expect(text).toBe('');
  else {
    for (const phrase of fixture.requiredFragments) expect(normalized(text), `${id}: ${phrase}`).toContain(phrase);
    await expect(page.locator('#confidence')).toContainText(/^Skor mesin \d+\/100$/);
  }
  return text;
}

async function finished(page, expectedState = 'Siap diedit') {
  await expect.poll(() => page.locator('#resultState').textContent(), {
    timeout: 120_000,
    message: 'Actual OCR must finish or report its real error',
  }).toMatch(/^(Siap diedit|Tidak ada teks|Belum berhasil)$/u);
  const actual = await page.locator('#resultState').textContent();
  expect(actual, `OCR status; error detail: ${await page.locator('#errorText').textContent()}`).toBe(expectedState);
}

async function screenshot(page, filename) {
  await mkdir(screenshotRoot, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(filename, screenshotRoot)), fullPage: true });
}

test.beforeEach(async ({ page, context }) => {
  const observed = { requests: [], responses: [], failedRequests: [], errors: [] };
  traffic.set(context, observed);
  context.on('request', (request) => observed.requests.push({ url: request.url(), method: request.method() }));
  context.on('response', (response) => observed.responses.push({ url: response.url(), status: response.status() }));
  context.on('requestfailed', (request) => observed.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('pageerror', (error) => observed.errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ambil teks dari gambar.' })).toBeVisible();
});

test.afterEach(async ({ context }, testInfo) => {
  const observed = traffic.get(context);
  const uploads = observed.requests.filter((request) => !['GET', 'HEAD'].includes(request.method));
  const thirdParty = observed.requests.filter((request) => {
    if (!/^https?:/u.test(request.url)) return false;
    return new URL(request.url).origin !== 'http://127.0.0.1:8124';
  });
  await testInfo.attach('same-origin-network-proof.json', {
    body: JSON.stringify({ ...observed, uploads, thirdParty }, null, 2),
    contentType: 'application/json',
  });
  expect(uploads, 'Image/text data must never be uploaded').toEqual([]);
  expect(thirdParty, 'OCR assets must come from the application origin').toEqual([]);
  expect(observed.errors, 'No uncaught application errors').toEqual([]);
});

test('real Indonesian + English OCR reads receipt; exports the edited text through clipboard and download', async ({ page, context }) => {
  await upload(page, 'indonesian-receipt');
  await recognize(page, 'indonesian-receipt', 'ind+eng');
  await screenshot(page, '01-receipt-light.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, '03-receipt-mobile.png');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const edited = 'Catatan pengguna: periksa Rp20.000.\nTeks résumé siap disalin. <b>tetap teks</b>';
  await page.locator('#output').fill(edited);
  await expect(page.locator('#resultState')).toHaveText('Sudah diedit');
  await page.locator('#copyButton').click();
  await expect(page.locator('#status')).toHaveText('Teks sudah disalin ke clipboard.');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.replace(/\r\n/gu, '\n')).toBe(edited);
  const waiting = page.waitForEvent('download');
  await page.locator('#downloadButton').click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe('hasil-ocr-indonesian-receipt.txt');
  expect(await readFile(await download.path(), 'utf8')).toBe(edited);
});

for (const id of ['english-jpeg', 'english-webp', 'english-transparent', 'english-exif']) {
  test(`real English OCR reads ${id}`, async ({ page }) => {
    await upload(page, id);
    if (id === 'english-exif') await expect(page.locator('#imageDetails')).toContainText('1200 × 820');
    if (id === 'english-transparent') {
      expect(await page.locator('#canvasHost canvas').evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data])).toEqual([255, 255, 255, 255]);
    }
    await recognize(page, id);
    if (id === 'english-jpeg') {
      await page.locator('#themeButton').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await screenshot(page, '02-english-dark.png');
    }
  });
}

test('real Indonesian OCR reads a sideways PNG after Putar kanan', async ({ page }) => {
  await upload(page, 'indonesian-sideways');
  await page.getByRole('button', { name: 'Putar kanan' }).click();
  await expect(page.locator('#rotationValue')).toHaveText('90°');
  await expect(page.locator('#imageDetails')).toContainText('850 × 1000');
  await expect(page.locator('#readButton')).toBeEnabled();
  await recognize(page, 'indonesian-sideways', 'ind');
});

test('real OCR of a blank PNG reports empty text and disables export', async ({ page }) => {
  await upload(page, 'blank');
  await recognize(page, 'blank');
  await expect(page.locator('#copyButton')).toBeDisabled();
  await expect(page.locator('#downloadButton')).toBeDisabled();
  await expect(page.locator('#confidence')).toBeHidden();
});

test('invalid and oversized files are rejected while an existing image and edited text stay available', async ({ page }) => {
  await upload(page, 'english-jpeg');
  await page.locator('#output').fill('Catatan tetap tersedia.');
  for (const id of ['corrupt', 'huge-header', 'animated-webp', 'unsupported-svg']) {
    await page.locator('#imageInput').setInputFiles(fixturePath(id));
    await expect(page.locator('#errorBox')).toBeVisible();
    await expect(page.locator('#status')).toHaveText('Gambar belum dapat dipakai. Pilih file lain.');
    await expect(page.locator('#fileName')).toHaveText('english-note.jpg');
    await expect(page.locator('#output')).toHaveValue('Catatan tetap tersedia.');
  }
  await page.locator('#imageInput').setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(page.locator('#errorText')).toContainText('10 MiB');
  await expect(page.locator('#output')).toHaveValue('Catatan tetap tersedia.');
  await page.locator('#imageInput').setInputFiles({ name: 'renamed.txt', mimeType: 'text/plain', buffer: await readFile(fixturePath('indonesian-receipt')) });
  await expect(page.locator('#fileName')).toHaveText('renamed.txt');
  await expect(page.locator('#errorBox')).toBeHidden();
});

test('cancelling an actual model download allows a queued real OCR retry and cannot replace newer text', async ({ page, context }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = 0;
  await context.route('**/ocr/lang/**', async (route) => {
    held += 1;
    await gate;
    await route.continue();
  });
  try {
    await upload(page, 'indonesian-receipt');
    await page.locator('#language').selectOption('ind');
    await page.locator('#readButton').click();
    await expect.poll(() => held, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.locator('#cancelButton').click();
    await expect(page.locator('#resultState')).toHaveText('Dibatalkan');
    await expect(page.locator('#output')).toHaveValue('');
    await upload(page, 'english-jpeg');
    await page.locator('#language').selectOption('eng');
    await page.locator('#readButton').click();
    await expect(page.locator('#stageText')).toContainText('Menunggu proses sebelumnya');
    release();
    await finished(page);
    const text = normalized(await page.locator('#output').inputValue());
    expect(text).toContain('inventory api');
    expect(text).not.toContain('toko kertas meja');
    await expect(page.locator('#readButton')).toBeEnabled();
  } finally {
    release();
  }
});

test('two native file events keep the latest image and its real OCR result', async ({ page }) => {
  const first = [...await readFile(fixturePath('indonesian-receipt'))];
  const second = [...await readFile(fixturePath('english-jpeg'))];
  await page.evaluate(({ first, second }) => {
    const input = document.getElementById('imageInput');
    for (const file of [
      new File([new Uint8Array(first)], 'older.png', { type: 'image/png' }),
      new File([new Uint8Array(second)], 'latest.jpg', { type: 'image/jpeg' }),
    ]) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { first, second });
  await expect(page.locator('#fileName')).toHaveText('latest.jpg');
  await expect(page.locator('#readButton')).toBeEnabled();
  await recognize(page, 'english-jpeg');
  await expect(page.locator('#fileName')).toHaveText('latest.jpg');
});

test('browser paste and drop events load actual files; image paste leaves an active text editor alone', async ({ page }) => {
  const receipt = [...await readFile(fixturePath('indonesian-receipt'))];
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
  }, receipt);
  await expect(page.locator('#fileName')).toHaveText('pasted.png');
  await expect(page.locator('#readButton')).toBeEnabled();
  await page.locator('#output').fill('Teks pengguna.');
  await page.locator('#output').evaluate((textarea, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'ignored.png', { type: 'image/png' }));
    textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
  }, receipt);
  await expect(page.locator('#output')).toHaveValue('Teks pengguna.');
  await expect(page.locator('#fileName')).toHaveText('pasted.png');
  await page.locator('#dropzone').evaluate((zone, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, receipt);
  await expect(page.locator('#fileName')).toHaveText('dropped.png');
  await expect(page.locator('#output')).toHaveValue('');
  await expect(page.locator('#readButton')).toBeEnabled();
});

test('injected worker network failure displays recovery and reload permits real OCR again', async ({ page, context }) => {
  await context.route('**/ocr/worker/worker.min.js', (route) => route.abort('failed'));
  await upload(page, 'english-jpeg');
  await page.locator('#language').selectOption('eng');
  await page.locator('#readButton').click();
  await expect(page.locator('#reloadButton')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#readButton')).toBeDisabled();
  await expect(page.locator('#errorText')).toContainText('Muat ulang aplikasi');
  await context.unroute('**/ocr/worker/worker.min.js');
  await page.locator('#reloadButton').click();
  await expect(page.locator('#errorBox')).toBeHidden();
  await upload(page, 'english-jpeg');
  await recognize(page, 'english-jpeg');
});

test('keyboard, reset and both themes work at 320, 390, 768, 1024 and 1440px without horizontal overflow', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Langsung ke hasil teks' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#output')).toBeFocused();
  await page.locator('#themeButton').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await upload(page, 'indonesian-receipt');
  for (const width of [320, 390, 768, 1024, 1_440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#themeButton').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px ${theme} overflow`).toBe(true);
      for (const id of ['themeButton', 'replaceButton', 'rotateLeft', 'rotateRight', 'readButton']) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.height, `${width}px ${theme} ${id} target`).toBeGreaterThanOrEqual(44);
        expect(box.x, `${id} left edge`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${id} right edge`).toBeLessThanOrEqual(width + 1);
      }
    }
  }
  await page.locator('#output').fill('Catatan sementara.');
  await page.locator('#resetButton').click();
  await expect(page.locator('#output')).toHaveValue('');
  await expect(page.locator('#emptyPreview')).toBeVisible();
  await expect(page.locator('#canvasHost canvas')).toHaveCount(0);
  await expect(page.locator('#readButton')).toBeDisabled();
  await expect(page.locator('#copyButton')).toBeDisabled();
});
