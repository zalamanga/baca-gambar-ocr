import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  IMAGE_LIMITS,
  ImageValidationError,
  inspectImage,
  inspectImageBytes,
  processingDimensions,
} from '../src/image.js';

function pngChunk(name, data = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(name, 4);
  data.copy(chunk, 8);
  return chunk;
}

function png(width = 640, height = 480, extra = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...extra,
    pngChunk('IDAT', Buffer.from([0])),
    pngChunk('IEND'),
  ]);
}

function jpeg(width = 640, height = 480, marker = 0xc0) {
  const frame = Buffer.alloc(10);
  frame[0] = 0xff;
  frame[1] = marker;
  frame.writeUInt16BE(8, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame]);
}

function webpChunk(name, data) {
  const chunk = Buffer.alloc(8 + data.length + (data.length & 1));
  chunk.write(name);
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

function riff(...chunks) {
  const payload = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function lossless(width = 640, height = 480) {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return webpChunk('VP8L', data);
}

function extended(width, height, flags = 0) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk('VP8X', data);
}

function rejectsCode(action, code) {
  assert.throws(action, (error) => error instanceof ImageValidationError && error.code === code);
}

test('PNG header reports dimensions and actual format', () => {
  const info = inspectImageBytes(png(), { name: 'renamed.txt' });
  assert.equal(info.width, 640);
  assert.equal(info.height, 480);
  assert.equal(info.pixels, 307_200);
  assert.equal(info.type, 'image/png');
  assert.equal(info.name, 'renamed.txt');
});

test('JPEG baseline and progressive frame dimensions are supported', () => {
  for (const marker of [0xc0, 0xc2]) {
    const info = inspectImageBytes(jpeg(1_200, 900, marker));
    assert.equal(info.width, 1_200);
    assert.equal(info.height, 900);
    assert.equal(info.type, 'image/jpeg');
  }
});

test('JPEG skips metadata segments without treating their payload as markers', () => {
  const image = jpeg(300, 200);
  const metadata = Buffer.from([0xff, 0xe1, 0x00, 0x06, 0xff, 0xc0, 0x00, 0x00]);
  const info = inspectImageBytes(Buffer.concat([image.subarray(0, 2), metadata, image.subarray(2)]));
  assert.equal(info.width, 300);
});

test('lossless WEBP dimensions are read from its packed frame header', () => {
  const info = inspectImageBytes(riff(lossless(1_280, 720)));
  assert.equal(info.width, 1_280);
  assert.equal(info.height, 720);
  assert.equal(info.type, 'image/webp');
});

test('lossy WEBP dimensions are supported', () => {
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(800, 6);
  data.writeUInt16LE(600, 8);
  const info = inspectImageBytes(riff(webpChunk('VP8 ', data)));
  assert.equal(info.width, 800);
  assert.equal(info.height, 600);
});

test('extended static WEBP uses canvas dimensions', () => {
  const info = inspectImageBytes(riff(extended(900, 700), lossless(900, 700)));
  assert.equal(info.width, 900);
  assert.equal(info.height, 700);
});

test('typed-array slices respect their byte offset', () => {
  const original = png(300, 210);
  const padded = Buffer.concat([Buffer.alloc(17), original, Buffer.alloc(7)]);
  const info = inspectImageBytes(padded.subarray(17, 17 + original.length));
  assert.equal(info.width, 300);
  assert.equal(info.height, 210);
});

test('empty and unsupported files have actionable errors', () => {
  rejectsCode(() => inspectImageBytes(new Uint8Array()), 'empty-file');
  for (const text of ['GIF89a', '<svg></svg>', '%PDF-1.7', 'not an image']) {
    rejectsCode(() => inspectImageBytes(Buffer.from(text)), 'unsupported-type');
  }
});

test('file size is rejected before reading bytes', async () => {
  let read = false;
  await assert.rejects(inspectImage({
    size: IMAGE_LIMITS.maxBytes + 1,
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); },
  }), { code: 'file-too-large' });
  assert.equal(read, false);
});

test('reported byte length must agree with inspected bytes', () => {
  const image = png();
  rejectsCode(() => inspectImageBytes(image, { size: image.length + 1 }), 'invalid-image');
});

test('zero, huge side, and excessive pixel counts are rejected from headers', () => {
  rejectsCode(() => inspectImageBytes(png(0, 300)), 'invalid-image');
  rejectsCode(() => inspectImageBytes(png(8_001, 1)), 'dimensions-too-large');
  rejectsCode(() => inspectImageBytes(png(5_000, 4_000)), 'dimensions-too-large');
  rejectsCode(() => inspectImageBytes(png(100_000, 100_000)), 'dimensions-too-large');
  rejectsCode(() => inspectImageBytes(jpeg(6_000, 3_000)), 'dimensions-too-large');
  rejectsCode(() => inspectImageBytes(riff(extended(6_000, 3_000), lossless())), 'dimensions-too-large');
});

test('source limits allow exactly 16MP and an 8000px side', () => {
  assert.equal(inspectImageBytes(png(4_000, 4_000)).pixels, 16_000_000);
  assert.equal(inspectImageBytes(png(8_000, 2_000)).width, 8_000);
});

test('PNG animation is rejected even when its extension is .png', () => {
  rejectsCode(() => inspectImageBytes(png(640, 480, [pngChunk('acTL', Buffer.alloc(8))])), 'animated-image');
});

test('WEBP animation flag and animation chunks are rejected', () => {
  rejectsCode(() => inspectImageBytes(riff(extended(640, 480, 0x02), lossless())), 'animated-image');
  rejectsCode(() => inspectImageBytes(riff(lossless(), webpChunk('ANIM', Buffer.alloc(6)))), 'animated-image');
});

test('truncated PNG chunks cannot advance beyond the available buffer', () => {
  for (const length of [8, 17, 32, 35, 45]) {
    rejectsCode(() => inspectImageBytes(png().subarray(0, length)), 'invalid-image');
  }
});

test('malformed JPEG segment lengths and missing frame are rejected', () => {
  for (const bytes of [
    [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01],
    [0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff],
    [0xff, 0xd8, 0xff, 0xda],
    [0xff, 0xd8, 0x12, 0x34],
  ]) rejectsCode(() => inspectImageBytes(Uint8Array.from(bytes)), 'invalid-image');
});

test('malformed WEBP boundaries and invalid frame signatures are rejected', () => {
  const truncated = riff(lossless()).subarray(0, 20);
  rejectsCode(() => inspectImageBytes(truncated), 'invalid-image');
  rejectsCode(() => inspectImageBytes(riff(webpChunk('VP8 ', Buffer.alloc(10)))), 'invalid-image');
  rejectsCode(() => inspectImageBytes(riff(extended(100, 100))), 'invalid-image');
});

test('normal image processing preserves its size', () => {
  const dimensions = processingDimensions(1_200, 900);
  assert.equal(dimensions.width, 1_200);
  assert.equal(dimensions.height, 900);
  assert.equal(dimensions.scale, 1);
});

test('quarter turns swap dimensions and half turns preserve dimensions', () => {
  for (const rotation of [90, 270]) {
    const result = processingDimensions(1_200, 900, rotation);
    assert.equal(result.width, 900);
    assert.equal(result.height, 1_200);
  }
  assert.equal(processingDimensions(1_200, 900, 180).width, 1_200);
  rejectsCode(() => processingDimensions(1_200, 900, 45), 'invalid-rotation');
});

test('processing obeys both six-megapixel and longest-side limits', () => {
  const square = processingDimensions(4_000, 4_000);
  assert.ok(square.width * square.height <= IMAGE_LIMITS.processMaxPixels);
  assert.equal(square.width, square.height);
  assert.ok(square.width <= IMAGE_LIMITS.processMaxSide);
  const long = processingDimensions(8_000, 2_000);
  assert.equal(long.width, 3_000);
  assert.equal(long.height, 750);
});

test('valid fixture files have the committed dimensions and signature type', async () => {
  const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'));
  for (const fixture of manifest.cases.filter((item) => item.valid)) {
    const bytes = await readFile(new URL(`./fixtures/${fixture.file}`, import.meta.url));
    const info = inspectImageBytes(bytes);
    assert.equal(info.width, fixture.width, fixture.id);
    assert.equal(info.height, fixture.height, fixture.id);
    assert.equal(info.type, fixture.mime, fixture.id);
  }
});

test('invalid fixtures are rejected from bytes before browser decoding', async () => {
  const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'));
  for (const fixture of manifest.cases.filter((item) => !item.valid)) {
    const bytes = await readFile(new URL(`./fixtures/${fixture.file}`, import.meta.url));
    rejectsCode(() => inspectImageBytes(bytes), fixture.rejectCode);
  }
});
