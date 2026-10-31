const LANGUAGES = new Set(['ind', 'eng', 'ind+eng']);

function abortError() {
  const error = new Error('Pembacaan gambar dibatalkan.');
  error.name = 'AbortError';
  return error;
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value || 'Mesin OCR mengalami kesalahan.'));
}

function reloadError(message, code, cause) {
  const error = new Error(message, cause ? { cause: asError(cause) } : undefined);
  error.requiresReload = true;
  error.code = code;
  return error;
}

function score(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function box(value) {
  if (!value || !['x0', 'y0', 'x1', 'y1'].every((key) => Number.isFinite(value[key]))) return null;
  if (value.x0 < 0 || value.y0 < 0 || value.x1 < value.x0 || value.y1 < value.y0) return null;
  return { x0: value.x0, y0: value.y0, x1: value.x1, y1: value.y1 };
}

function resultFrom(data, language) {
  const words = [];
  for (const block of Array.isArray(data?.blocks) ? data.blocks : []) {
    for (const paragraph of Array.isArray(block?.paragraphs) ? block.paragraphs : []) {
      for (const line of Array.isArray(paragraph?.lines) ? paragraph.lines : []) {
        for (const word of Array.isArray(line?.words) ? line.words : []) {
          if (typeof word?.text !== 'string' || !word.text.trim()) continue;
          words.push({ text: word.text, confidence: score(word.confidence), bbox: box(word.bbox) });
        }
      }
    }
  }
  return {
    text: typeof data?.text === 'string' ? data.text : '',
    confidence: score(data?.confidence),
    words,
    language,
  };
}

async function defaultWorkerFactory(...args) {
  const { createWorker } = await import('tesseract.js');
  return createWorker(...args);
}

/**
 * Owns one OCR worker at a time. Worker creation is not abortable in Tesseract.js;
 * cancelled startup jobs are terminated as soon as initialization returns a handle.
 * `cancel()` settles the OCR promise immediately and resolves after worker cleanup.
 */
export function createOcrEngine({ createWorker = defaultWorkerFactory, workerOptions = {} } = {}) {
  let queue = Promise.resolve();
  let current = null;
  let disposed = false;
  let cleanupError = null;
  let pendingJobs = 0;

  function interrupt(job) {
    if (!job || job.cancelled) return;
    job.cancelled = true;
    job.reject(abortError());
    job.wake();
  }

  function blockInitialization(job, cause) {
    cleanupError ??= reloadError(
      'Mesin OCR gagal dimuat dan belum dapat ditutup. Muat ulang aplikasi untuk mencoba lagi.',
      'OCR_INITIALIZATION_BLOCKED',
      cause,
    );
    job.error = cleanupError;
    job.reject(cleanupError);
    job.wake();
    // A cancelled initializer can still fail while a newer job waits for it.
    if (current && current !== job) {
      current.error = cleanupError;
      current.reject(cleanupError);
      current.wake();
    }
    return cleanupError;
  }

  async function run(job) {
    if (job.cancelled) {
      job.signal?.removeEventListener('abort', job.abort);
      if (current === job) current = null;
      return;
    }
    if (cleanupError) {
      job.reject(cleanupError);
      job.signal?.removeEventListener('abort', job.abort);
      if (current === job) current = null;
      return;
    }

    let worker;
    let result;
    let error;
    try {
      worker = await createWorker(job.language.split('+'), 1, {
        ...workerOptions,
        logger(message) {
          if (current !== job || job.cancelled || job.error) return;
          if (typeof message?.status !== 'string') return;
          const progress = Number.isFinite(message.progress)
            ? Math.max(0, Math.min(1, message.progress))
            : null;
          job.onProgress?.({ status: message.status, progress });
        },
        errorHandler(value) {
          if (!worker) {
            blockInitialization(job, value);
            return;
          }
          if (job.cancelled) return;
          job.error = asError(value);
          job.reject(job.error);
          job.wake();
        },
      });
      if (job.cancelled) throw abortError();
      if (job.error) throw job.error;

      // Tesseract does not settle an in-flight recognize promise when terminated.
      const outcome = await Promise.race([
        Promise.resolve(worker.recognize(job.image, {}, { text: true, blocks: true }))
          .then((value) => ({ value })),
        job.interrupted.then(() => ({ interrupted: true })),
      ]);
      if (job.cancelled || current !== job) throw abortError();
      if (job.error) throw job.error;
      if (outcome.interrupted) throw abortError();
      result = resultFrom(outcome.value?.data, job.language);
    } catch (cause) {
      // Rejected startup also hides the spawned worker handle in Tesseract.js 7.
      if (!worker) error = blockInitialization(job, cause);
      else error = job.cancelled ? abortError() : asError(cause);
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch {
          cleanupError = reloadError(
            'Worker OCR tidak dapat ditutup. Muat ulang aplikasi sebelum mencoba lagi.',
            'OCR_CLEANUP_FAILED',
          );
          error = cleanupError;
        }
      }
      job.signal?.removeEventListener('abort', job.abort);
      if (current === job) current = null;
    }

    if (job.cancelled) job.reject(abortError());
    else if (error) job.reject(error);
    else job.resolve(result);
  }

  function recognize(image, { language = 'ind+eng', onProgress, signal } = {}) {
    if (disposed) return Promise.reject(new Error('Mesin OCR sudah ditutup.'));
    if (!LANGUAGES.has(language)) return Promise.reject(new Error('Pilih bahasa Indonesia, Inggris, atau keduanya.'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (cleanupError) return Promise.reject(cleanupError);

    interrupt(current);
    let resolve;
    let reject;
    let wake;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const interrupted = new Promise((yes) => { wake = yes; });
    const job = { image, language, onProgress, signal, resolve, reject, wake, interrupted, cancelled: false };
    job.abort = () => interrupt(job);
    signal?.addEventListener('abort', job.abort, { once: true });
    current = job;
    const waitingForCleanup = pendingJobs > 0;
    pendingJobs += 1;
    queue = queue.then(() => run(job)).finally(() => { pendingJobs -= 1; });
    if (waitingForCleanup) onProgress?.({ status: 'waiting for worker cleanup', progress: null });
    return promise;
  }

  function cancel() {
    interrupt(current);
    return queue;
  }

  function dispose() {
    disposed = true;
    return cancel();
  }

  return { recognize, cancel, dispose };
}
