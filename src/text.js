export function textStats(text) {
  return {
    words: text.trim() ? text.trim().split(/\s+/u).length : 0,
    characters: Array.from(text).length,
  };
}

export function downloadName(filename = "gambar") {
  const basename = filename.split(/[\\/]/).at(-1);
  const stem = basename
    .replace(/\.[^.]*$/, "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 70);
  return `hasil-ocr-${stem || "gambar"}.txt`;
}
