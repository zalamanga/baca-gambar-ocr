import test from "node:test";
import assert from "node:assert/strict";
import { textStats, downloadName } from "../src/text.js";

test("empty and whitespace text have no words", () => {
  assert.deepEqual(textStats(""), { words: 0, characters: 0 });
  assert.deepEqual(textStats(" \n\t"), { words: 0, characters: 3 });
});
test("word count handles line breaks and counts Unicode code points", () => {
  assert.deepEqual(textStats("Halo\n世界 👋"), { words: 3, characters: 9 });
});
test("plain text export uses safe filenames and retains Indonesian names", () => {
  assert.equal(downloadName("Nota Belanja.png"), "hasil-ocr-Nota Belanja.txt");
  assert.equal(downloadName("CON.jpg"), "hasil-ocr-CON.txt");
  assert.equal(downloadName("../../rahasia?.png"), "hasil-ocr-rahasia-.txt");
  assert.equal(downloadName(".png"), "hasil-ocr-gambar.txt");
});
