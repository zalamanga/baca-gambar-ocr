import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcrEngine } from '../src/ocr.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const abort = (error) => error.name === 'AbortError';

test('requests real detailed output and returns Indonesian/English text, scores, and word boxes', async () => {
  const calls = [];
  const progress = [];
  const image = { fixture: 'synthetic' };
  let terminated = 0;
  const engine = createOcrEngine({
    workerOptions: { langPath: '/models' },
    async createWorker(languages, oem, options) {
      calls.push({ languages, oem, langPath: options.langPath });
      options.logger({ status: 'loading language traineddata', progress: 0.5 });
      return {
        async recognize(input, options, output) {
          assert.equal(input, image);
          assert.deepEqual(options, {});
          assert.deepEqual(output, { text: true, blocks: true });
          return { data: {
            text: 'Selamat pagi\nGood morning\n', confidence: 92.3,
            blocks: [{ paragraphs: [{ lines: [{ words: [
              { text: 'Selamat', confidence: 96.1, bbox: { x0: 10, y0: 20, x1: 90, y1: 45 } },
              { text: 'pagi', confidence: 88, bbox: { x0: 95, y0: 20, x1: 140, y1: 45 } },
            ] }] }] }],
          } };
        },
        async terminate() { terminated += 1; },
      };
    },
  });
  const result = await engine.recognize(image, { onProgress: (message) => progress.push(message) });
  assert.deepEqual(calls, [{ languages: ['ind', 'eng'], oem: 1, langPath: '/models' }]);
  assert.deepEqual(progress, [{ status: 'loading language traineddata', progress: 0.5 }]);
  assert.equal(result.text, 'Selamat pagi\nGood morning\n');
  assert.equal(result.confidence, 92.3);
  assert.equal(result.language, 'ind+eng');
  assert.deepEqual(result.words[0], { text: 'Selamat', confidence: 96.1, bbox: { x0: 10, y0: 20, x1: 90, y1: 45 } });
  assert.equal(terminated, 1);
});

test('empty OCR is a valid result and missing scores are not invented', async () => {
  const engine = createOcrEngine({ createWorker: async () => ({
    recognize: async () => ({ data: { text: '', blocks: null } }),
    terminate: async () => {},
  }) });
  assert.deepEqual(await engine.recognize('blank', { language: 'eng' }), {
    text: '', confidence: null, words: [], language: 'eng',
  });
});

test('invalid word metadata is omitted or null instead of becoming a fake score or box', async () => {
  const engine = createOcrEngine({ createWorker: async () => ({
    recognize: async () => ({ data: { confidence: -1, blocks: [null, { paragraphs: [null,
      { lines: [null, { words: [null, { text: '  ' }, { text: 'A', confidence: 101,
        bbox: { x0: 10, y0: 0, x1: 2, y1: 30 } }] }] },
    ] }] } }),
    terminate: async () => {},
  }) });
  const result = await engine.recognize('image', { language: 'ind' });
  assert.equal(result.confidence, null);
  assert.deepEqual(result.words, [{ text: 'A', confidence: null, bbox: null }]);
});

test('cancel terminates a running worker even if recognition never settles', async () => {
  const running = defer();
  let terminated = 0;
  let logger;
  const progress = [];
  const engine = createOcrEngine({ createWorker: async (_languages, _oem, options) => {
    logger = options.logger;
    return { recognize: () => running.promise, terminate: async () => { terminated += 1; } };
  } });
  const pending = engine.recognize('image', { onProgress: (message) => progress.push(message) });
  const rejected = assert.rejects(pending, abort);
  await tick();
  logger({ status: 'recognizing text', progress: 0.25 });
  await engine.cancel();
  await rejected;
  logger({ status: 'recognizing text', progress: 0.9 });
  running.resolve({ data: { text: 'stale' } });
  await tick();
  assert.equal(terminated, 1);
  assert.deepEqual(progress, [{ status: 'recognizing text', progress: 0.25 }]);
});

test('superseding a request waits for old termination before creating the next worker', async () => {
  const oldRecognition = defer();
  const oldTermination = defer();
  const order = [];
  let count = 0;
  const engine = createOcrEngine({ createWorker: async () => {
    count += 1;
    const id = count;
    order.push(`create-${id}`);
    return {
      recognize: () => id === 1 ? oldRecognition.promise : Promise.resolve({ data: { text: 'new' } }),
      async terminate() {
        order.push(`terminate-${id}`);
        if (id === 1) await oldTermination.promise;
      },
    };
  } });
  const first = engine.recognize('old');
  const firstRejected = assert.rejects(first, abort);
  await tick();
  const secondProgress = [];
  const second = engine.recognize('new', { language: 'eng', onProgress: (message) => secondProgress.push(message) });
  await tick();
  assert.deepEqual(order, ['create-1', 'terminate-1']);
  assert.deepEqual(secondProgress, [{ status: 'waiting for worker cleanup', progress: null }]);
  oldTermination.resolve();
  assert.equal((await second).text, 'new');
  await firstRejected;
  assert.deepEqual(order, ['create-1', 'terminate-1', 'create-2', 'terminate-2']);
  oldRecognition.reject(new Error('late old failure'));
  await tick();
});

test('cancellation during initialization settles promptly and cleans up before another startup', async () => {
  const startup = defer();
  let count = 0;
  let terminated = 0;
  const engine = createOcrEngine({ createWorker: async () => {
    count += 1;
    if (count === 1) return startup.promise;
    return { recognize: async () => ({ data: { text: 'second' } }), terminate: async () => {} };
  } });
  const first = engine.recognize('first');
  const rejected = assert.rejects(first, abort);
  await tick();
  const cleanup = engine.cancel();
  await rejected;
  const second = engine.recognize('second');
  await tick();
  assert.equal(count, 1);
  startup.resolve({
    recognize: async () => { assert.fail('cancelled startup must not recognize an image'); },
    terminate: async () => { terminated += 1; },
  });
  await cleanup;
  assert.equal((await second).text, 'second');
  assert.equal(terminated, 1);
});

test('AbortSignal cancels an active worker and pre-aborted signals do not create a worker', async () => {
  let created = 0;
  let terminated = 0;
  const engine = createOcrEngine({ createWorker: async () => {
    created += 1;
    return { recognize: () => new Promise(() => {}), terminate: async () => { terminated += 1; } };
  } });
  const previous = new AbortController();
  previous.abort();
  await assert.rejects(engine.recognize('image', { signal: previous.signal }), abort);
  assert.equal(created, 0);
  const controller = new AbortController();
  const pending = engine.recognize('image', { signal: controller.signal });
  const rejected = assert.rejects(pending, abort);
  await tick();
  controller.abort();
  await rejected;
  await engine.cancel();
  assert.equal(created, 1);
  assert.equal(terminated, 1);
});

test('real recognition errors release the worker and allow a later attempt', async () => {
  let created = 0;
  let terminated = 0;
  const engine = createOcrEngine({ createWorker: async () => {
    created += 1;
    const id = created;
    return {
      recognize: async () => { if (id === 1) throw new Error('decode failed'); return { data: { text: 'retry' } }; },
      terminate: async () => { terminated += 1; },
    };
  } });
  await assert.rejects(engine.recognize('broken'), /decode failed/);
  assert.equal((await engine.recognize('valid')).text, 'retry');
  assert.equal(terminated, 2);
});

test('startup rejection requires reload because the vendor exposes no cleanup handle', async () => {
  let created = 0;
  const engine = createOcrEngine({ createWorker: async () => {
    created += 1;
    throw new Error('runtime unavailable');
  } });
  await assert.rejects(engine.recognize('first'), (error) => {
    assert.equal(error.requiresReload, true);
    assert.equal(error.code, 'OCR_INITIALIZATION_BLOCKED');
    assert.match(error.cause.message, /runtime unavailable/);
    return true;
  });
  await assert.rejects(engine.recognize('second'), (error) => error.requiresReload === true);
  assert.equal(created, 1);
});

test('reset before the queued task starts creates no worker', async () => {
  let created = 0;
  const engine = createOcrEngine({ createWorker: async () => { created += 1; assert.fail('cancelled'); } });
  const pending = engine.recognize('image');
  const rejected = assert.rejects(pending, abort);
  await engine.cancel();
  await rejected;
  assert.equal(created, 0);
});

test('worker error callbacks reject immediately and terminate once startup returns', async () => {
  const startup = defer();
  let reportError;
  let terminated = 0;
  const engine = createOcrEngine({ createWorker: async (_languages, _oem, options) => {
    reportError = options.errorHandler;
    return startup.promise;
  } });
  const pending = engine.recognize('image');
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.requiresReload, true);
    assert.equal(error.code, 'OCR_INITIALIZATION_BLOCKED');
    assert.match(error.cause.message, /language unavailable/);
    return true;
  });
  await tick();
  reportError('language unavailable');
  await rejected;
  startup.resolve({ recognize: async () => assert.fail('initialization failed'),
    terminate: async () => { terminated += 1; } });
  await engine.cancel();
  assert.equal(terminated, 1);
});

test('a failed cancelled initializer rejects the queued request with reload diagnostics', async () => {
  const startup = defer();
  let reportError;
  let created = 0;
  const engine = createOcrEngine({ createWorker: async (_languages, _oem, options) => {
    created += 1;
    reportError = options.errorHandler;
    return startup.promise;
  } });
  const first = engine.recognize('first');
  const firstRejected = assert.rejects(first, abort);
  await tick();
  const progress = [];
  const second = engine.recognize('second', { onProgress: (message) => progress.push(message) });
  const secondRejected = assert.rejects(second, (error) => error.requiresReload === true
    && error.code === 'OCR_INITIALIZATION_BLOCKED');
  await firstRejected;
  reportError('failed to load language');
  await secondRejected;
  await assert.rejects(engine.recognize('third'), (error) => error.requiresReload === true);
  assert.equal(created, 1);
  assert.deepEqual(progress, [{ status: 'waiting for worker cleanup', progress: null }]);
  startup.resolve({ recognize: async () => assert.fail('cancelled'), terminate: async () => {} });
  await engine.cancel();
});

test('a cancelled startup promise rejection also fails the queued request instead of starting another worker', async () => {
  const startup = defer();
  let created = 0;
  const engine = createOcrEngine({ createWorker: async () => { created += 1; return startup.promise; } });
  const first = engine.recognize('first');
  const firstRejected = assert.rejects(first, abort);
  await tick();
  const second = engine.recognize('second');
  const secondRejected = assert.rejects(second, (error) => error.requiresReload === true);
  await firstRejected;
  startup.reject(new Error('worker load failed'));
  await secondRejected;
  await engine.cancel();
  assert.equal(created, 1);
});

test('worker error callbacks during recognition allow ordinary retries after cleanup', async () => {
  let reportError;
  let created = 0;
  const engine = createOcrEngine({ createWorker: async (_languages, _oem, options) => {
    created += 1;
    reportError = options.errorHandler;
    const id = created;
    return { recognize: () => id === 1 ? new Promise(() => {}) : Promise.resolve({ data: { text: 'retried' } }),
      terminate: async () => {} };
  } });
  const pending = engine.recognize('image');
  const rejected = assert.rejects(pending, (error) => {
    assert.match(error.message, /recognition failed/);
    assert.equal(error.requiresReload, undefined);
    return true;
  });
  await tick();
  reportError('recognition failed');
  await rejected;
  assert.equal((await engine.recognize('image')).text, 'retried');
  assert.equal(created, 2);
});

test('worker cleanup failures prevent creating another worker', async () => {
  let created = 0;
  const engine = createOcrEngine({ createWorker: async () => {
    created += 1;
    return { recognize: async () => ({ data: { text: 'result' } }),
      terminate: async () => { throw new Error('worker stuck'); } };
  } });
  await assert.rejects(engine.recognize('image'), (error) => error.requiresReload === true
    && error.code === 'OCR_CLEANUP_FAILED');
  await assert.rejects(engine.recognize('image'), (error) => error.requiresReload === true);
  assert.equal(created, 1);
});

test('invalid languages are rejected before creating a worker and dispose closes future requests', async () => {
  let created = 0;
  const engine = createOcrEngine({ createWorker: async () => { created += 1; assert.fail('should not create'); } });
  await assert.rejects(engine.recognize('image', { language: 'fra' }), /Pilih bahasa/);
  await engine.dispose();
  await assert.rejects(engine.recognize('image'), /sudah ditutup/);
  assert.equal(created, 0);
});
