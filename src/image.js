export const IMAGE_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPixels: 16_000_000,
  maxSide: 8_000,
  processMaxPixels: 6_000_000,
  processMaxSide: 3_000,
});

export class ImageValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageValidationError';
    this.code = code;
  }
}

const invalid = () => new ImageValidationError(
  'invalid-image',
  'File gambar rusak atau tidak lengkap. Pilih gambar lain.',
);

function assertDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw invalid();
  }
  if (width > IMAGE_LIMITS.maxSide || height > IMAGE_LIMITS.maxSide
    || width * height > IMAGE_LIMITS.maxPixels) {
    throw new ImageValidationError(
      'dimensions-too-large',
      'Ukuran gambar maksimal 16 megapiksel dan 8.000 piksel per sisi. Kecilkan gambar dahulu.',
    );
  }
}

function assertSize(size) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new ImageValidationError('empty-file', 'File kosong. Pilih gambar PNG, JPEG, atau WEBP.');
  }
  if (size > IMAGE_LIMITS.maxBytes) {
    throw new ImageValidationError('file-too-large', 'Ukuran file maksimal 10 MiB. Kecilkan file dahulu.');
  }
}

function textAt(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function rejectAnimation() {
  throw new ImageValidationError('animated-image', 'Gambar animasi belum didukung. Gunakan gambar statis.');
}

function pngDimensions(bytes, view) {
  if (bytes.length < 33 || view.getUint32(8) !== 13 || textAt(bytes, 12, 4) !== 'IHDR') throw invalid();
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  assertDimensions(width, height);
  let offset = 8;
  let hasData = false;
  let hasEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw invalid();
    const chunk = textAt(bytes, offset + 4, 4);
    if (chunk === 'acTL') rejectAnimation();
    if (chunk === 'IDAT') hasData = true;
    if (chunk === 'IEND') {
      if (length !== 0) throw invalid();
      hasEnd = true;
      break;
    }
    offset += length + 12;
  }
  if (!hasData || !hasEnd) throw invalid();
  return { width, height };
}

function jpegDimensions(bytes, view) {
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw invalid();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw invalid();
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === 0x00) throw invalid();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw invalid();
    const length = view.getUint16(offset);
    if (length < 2 || length > bytes.length - offset) throw invalid();
    if (frameMarkers.has(marker)) {
      if (length < 8) throw invalid();
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      assertDimensions(width, height);
      return { width, height };
    }
    offset += length;
  }
  throw invalid();
}

function webpDimensions(bytes, view) {
  if (bytes.length < 20) throw invalid();
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.length || end < 20) throw invalid();
  let offset = 12;
  let dimensions;
  let hasImage = false;
  while (offset + 8 <= end) {
    const chunk = textAt(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (length > end - data) throw invalid();
    if (chunk === 'ANIM' || chunk === 'ANMF') rejectAnimation();
    if (chunk === 'VP8X') {
      if (length !== 10) throw invalid();
      if (bytes[data] & 0x02) rejectAnimation();
      const width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
      const height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
      assertDimensions(width, height);
      dimensions = { width, height };
    } else if (chunk === 'VP8 ') {
      if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) throw invalid();
      const width = view.getUint16(data + 6, true) & 0x3fff;
      const height = view.getUint16(data + 8, true) & 0x3fff;
      assertDimensions(width, height);
      dimensions ??= { width, height };
      hasImage = true;
    } else if (chunk === 'VP8L') {
      if (length < 5 || bytes[data] !== 0x2f) throw invalid();
      const bits = view.getUint32(data + 1, true);
      if (bits >>> 29) throw invalid();
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      assertDimensions(width, height);
      dimensions ??= { width, height };
      hasImage = true;
    }
    offset = data + length + (length & 1);
  }
  if (!dimensions || !hasImage || offset !== end) throw invalid();
  return dimensions;
}

export function inspectImageBytes(input, { size, name = '' } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const actualSize = size ?? bytes.byteLength;
  assertSize(actualSize);
  if (actualSize !== bytes.byteLength) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format;
  let dimensions;
  if (bytes.length >= 8 && bytes[0] === 0x89 && textAt(bytes, 1, 3) === 'PNG'
    && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
    format = 'png';
    dimensions = pngDimensions(bytes, view);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'jpeg';
    dimensions = jpegDimensions(bytes, view);
  } else if (bytes.length >= 12 && textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP') {
    format = 'webp';
    dimensions = webpDimensions(bytes, view);
  } else {
    throw new ImageValidationError('unsupported-type', 'Format belum didukung. Gunakan PNG, JPEG, atau WEBP statis.');
  }
  return { ...dimensions, pixels: dimensions.width * dimensions.height, type: `image/${format}`, format, size: actualSize, name };
}

export async function inspectImage(file) {
  assertSize(file?.size);
  return inspectImageBytes(await file.arrayBuffer(), { size: file.size, name: file.name ?? '' });
}

export function processingDimensions(width, height, rotation = 0) {
  assertDimensions(width, height);
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new ImageValidationError('invalid-rotation', 'Rotasi harus 0, 90, 180, atau 270 derajat.');
  }
  const swapped = rotation === 90 || rotation === 270;
  const rotatedWidth = swapped ? height : width;
  const rotatedHeight = swapped ? width : height;
  const scale = Math.min(
    1,
    IMAGE_LIMITS.processMaxSide / rotatedWidth,
    IMAGE_LIMITS.processMaxSide / rotatedHeight,
    Math.sqrt(IMAGE_LIMITS.processMaxPixels / (rotatedWidth * rotatedHeight)),
  );
  return {
    width: Math.max(1, Math.floor(rotatedWidth * scale)),
    height: Math.max(1, Math.floor(rotatedHeight * scale)),
    rotatedWidth,
    rotatedHeight,
    scale,
  };
}

async function decode(file) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
    } catch {
      // Some browsers decode a format through <img> but not ImageBitmap.
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => { URL.revokeObjectURL(url); image.src = ''; },
    };
  } catch {
    URL.revokeObjectURL(url);
    image.src = '';
    throw new ImageValidationError('decode-failed', 'Gambar tidak dapat dibuka. File mungkin rusak; coba simpan ulang sebagai PNG atau JPEG.');
  } finally {
    image.onload = null;
    image.onerror = null;
  }
}

export async function prepareImage(file, { rotation = 0 } = {}) {
  const info = await inspectImage(file);
  const resource = await decode(file);
  let canvas;
  try {
    const { width, height } = processingDimensions(resource.width, resource.height, rotation);
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new ImageValidationError('canvas-unavailable', 'Browser tidak dapat menyiapkan gambar. Coba muat ulang halaman.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.translate(width / 2, height / 2);
    context.rotate(rotation * Math.PI / 180);
    const swapped = rotation === 90 || rotation === 270;
    const drawWidth = swapped ? height : width;
    const drawHeight = swapped ? width : height;
    context.drawImage(resource.source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    return {
      canvas,
      width,
      height,
      originalWidth: resource.width,
      originalHeight: resource.height,
      type: info.type,
      rotation,
      scaled: width !== (swapped ? resource.height : resource.width)
        || height !== (swapped ? resource.width : resource.height),
    };
  } catch (error) {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    throw error;
  } finally {
    resource.dispose();
  }
}
