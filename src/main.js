import "./styles.css";
import { createOcrEngine } from "./ocr.js";
import { prepareImage, ImageValidationError } from "./image.js";
import { textStats, downloadName } from "./text.js";

const $ = (id) => document.getElementById(id);
const base = new URL(import.meta.env.BASE_URL, location.href);
const engine = createOcrEngine({
  workerOptions: {
    workerPath: new URL("ocr/worker/worker.min.js", base).href,
    corePath: new URL("ocr/core", base).href,
    langPath: new URL("ocr/lang", base).href,
    workerBlobURL: false,
    gzip: false,
    cachePath: "baca-gambar-ocr-v1",
  },
});
let file = null;
let prepared = null;
let rotation = 0;
let version = 0;
let busy = false;
let preparing = false;
let needsReload = false;
let fatalMessage = "";
let rawText = null;
let lastStage = "";

function message(text) {
  $("status").textContent = text;
}
function clearError() {
  $("errorBox").hidden = !needsReload;
  $("errorText").textContent = needsReload ? fatalMessage : "";
  $("reloadButton").hidden = !needsReload;
}
function errorMessage(error) {
  if (error?.requiresReload) {
    needsReload = true;
    fatalMessage = error.message;
  }
  $("errorText").textContent = needsReload
    ? fatalMessage
    : error instanceof ImageValidationError
      ? error.message
      : "Pembacaan belum berhasil. Coba gambar yang lebih jelas atau ulangi prosesnya.";
  $("reloadButton").hidden = !needsReload;
  $("errorBox").hidden = false;
}
function updateCounts() {
  const { words, characters } = textStats($("output").value);
  $("textCount").textContent =
    `${words.toLocaleString("id-ID")} kata · ${characters.toLocaleString("id-ID")} karakter`;
  $("copyButton").disabled = busy || !$("output").value.trim();
  $("downloadButton").disabled = busy || !$("output").value.trim();
}
function controls() {
  $("readButton").disabled = !prepared || busy || preparing || needsReload;
  $("readButton").textContent =
    rawText === null ? "Ambil teks" : "Baca ulang gambar";
  $("cancelButton").hidden = !busy;
  $("resetButton").disabled = !file && !prepared && !$("output").value;
  for (const id of ["rotateLeft", "rotateRight"])
    $(id).disabled = !prepared || busy || preparing;
  $("language").disabled = busy;
  $("output").readOnly = busy;
  $("output").setAttribute("aria-busy", String(busy));
  updateCounts();
}
function releaseCanvas(value) {
  if (value) {
    value.canvas.width = 0;
    value.canvas.height = 0;
  }
}
function resetResult() {
  rawText = null;
  $("output").value = "";
  $("confidence").hidden = true;
  $("resultState").textContent = "Belum dibaca";
}
function cancelJob() {
  version += 1;
  busy = false;
  $("progressWrap").hidden = true;
  void engine.cancel();
}
async function selectFile(candidate) {
  if (!candidate) return;
  cancelJob();
  const token = version;
  preparing = true;
  clearError();
  message("Membuka gambar…");
  controls();
  try {
    const next = await prepareImage(candidate);
    if (token !== version) {
      releaseCanvas(next);
      return;
    }
    releaseCanvas(prepared);
    prepared = next;
    file = candidate;
    rotation = 0;
    resetResult();
    displayPreview();
    message("Gambar siap. Pilih bahasa, lalu ambil teksnya.");
  } catch (error) {
    if (token === version) {
      errorMessage(error);
      message("Gambar belum dapat dipakai. Pilih file lain.");
    }
  } finally {
    if (token === version) {
      preparing = false;
      controls();
    }
    $("imageInput").value = "";
  }
}
function displayPreview() {
  $("emptyPreview").hidden = true;
  $("previewWrap").hidden = false;
  prepared.canvas.setAttribute("role", "img");
  prepared.canvas.setAttribute(
    "aria-label",
    `Pratinjau ${file.name}, rotasi ${rotation} derajat`,
  );
  $("canvasHost").replaceChildren(prepared.canvas);
  $("fileName").textContent = file.name;
  const size = (file.size / 1024 / 1024).toLocaleString("id-ID", {
    maximumFractionDigits: 2,
  });
  $("imageDetails").textContent =
    `${size} MiB · ${prepared.width} × ${prepared.height} px${prepared.scaled ? " · diperkecil untuk OCR" : ""}`;
  $("rotationValue").textContent = `${rotation}°`;
}
async function rotate(delta) {
  if (!file || busy || preparing) return;
  const token = ++version;
  const nextRotation = (rotation + delta + 360) % 360;
  preparing = true;
  clearError();
  controls();
  try {
    const next = await prepareImage(file, { rotation: nextRotation });
    if (token !== version) {
      releaseCanvas(next);
      return;
    }
    releaseCanvas(prepared);
    prepared = next;
    rotation = nextRotation;
    displayPreview();
    message(
      rawText === null
        ? "Gambar sudah diputar. Siap dibaca."
        : "Gambar sudah diputar. Baca ulang untuk memperbarui teks.",
    );
  } catch (error) {
    if (token === version) errorMessage(error);
  } finally {
    if (token === version) {
      preparing = false;
      controls();
    }
  }
}
const stages = {
  "loading tesseract core": "Memuat mesin pembaca",
  "initializing tesseract": "Menyiapkan mesin pembaca",
  "loading language traineddata": "Memuat model bahasa",
  "initializing api": "Menyiapkan bahasa",
  "recognizing text": "Membaca tulisan pada gambar",
  "waiting for worker cleanup": "Menunggu proses sebelumnya ditutup",
};
async function readImage() {
  if (!prepared || busy || preparing || needsReload) return;
  const token = ++version;
  busy = true;
  clearError();
  lastStage = "";
  $("progressWrap").hidden = false;
  $("ocrProgress").removeAttribute("value");
  $("stageText").textContent = "Menyiapkan pembacaan";
  $("progressNumber").textContent = "";
  $("resultState").textContent = "Sedang dibaca";
  message("Pembacaan dimulai. Gambar tetap di browser Anda.");
  controls();
  try {
    const result = await engine.recognize(prepared.canvas, {
      language: $("language").value,
      onProgress({ status, progress }) {
        if (token !== version) return;
        const label = stages[status] || "Memproses gambar";
        $("stageText").textContent = label;
        if (progress === null) {
          $("ocrProgress").removeAttribute("value");
          $("progressNumber").textContent = "";
        } else {
          $("ocrProgress").value = progress;
          $("progressNumber").textContent =
            `${Math.round(progress * 100)}% tahap ini`;
        }
        if (status !== lastStage) {
          message(`${label}…`);
          lastStage = status;
        }
      },
    });
    if (token !== version) return;
    rawText = result.text.trim() ? result.text.trimEnd() : "";
    $("output").value = rawText;
    $("resultState").textContent = rawText ? "Siap diedit" : "Tidak ada teks";
    $("confidence").hidden = !rawText || result.confidence === null;
    if (result.confidence !== null)
      $("confidence").textContent =
        `Skor mesin ${Math.round(result.confidence)}/100`;
    message(
      rawText
        ? "Teks selesai dibaca. Periksa hasilnya sebelum disalin atau diunduh."
        : "Belum ada teks yang terbaca. Coba gambar lebih jelas, perbesar tulisan, atau putar gambarnya.",
    );
  } catch (error) {
    if (token !== version || error?.name === "AbortError") return;
    $("resultState").textContent = "Belum berhasil";
    errorMessage(error);
    message("Pembacaan berhenti. Teks sebelumnya tetap tersedia.");
  } finally {
    if (token === version) {
      busy = false;
      $("progressWrap").hidden = true;
      controls();
    }
  }
}
function reset() {
  cancelJob();
  preparing = false;
  releaseCanvas(prepared);
  prepared = null;
  file = null;
  rotation = 0;
  resetResult();
  $("canvasHost").replaceChildren();
  $("previewWrap").hidden = true;
  $("emptyPreview").hidden = false;
  $("rotationValue").textContent = "0°";
  clearError();
  message("Gambar dan teks sudah dikosongkan dari tab ini.");
  controls();
}
$("pickButton").addEventListener("click", () => $("imageInput").click());
$("replaceButton").addEventListener("click", () => $("imageInput").click());
$("imageInput").addEventListener(
  "change",
  (event) => void selectFile(event.target.files[0]),
);
$("readButton").addEventListener("click", () => void readImage());
$("cancelButton").addEventListener("click", () => {
  cancelJob();
  $("resultState").textContent =
    rawText === null ? "Dibatalkan" : "Teks sebelumnya";
  message("Pembacaan dibatalkan. Gambar tetap tersedia.");
  controls();
});
$("resetButton").addEventListener("click", reset);
$("rotateLeft").addEventListener("click", () => void rotate(-90));
$("rotateRight").addEventListener("click", () => void rotate(90));
$("reloadButton").addEventListener("click", () => location.reload());
$("output").addEventListener("input", () => {
  $("resultState").textContent =
    rawText === null
      ? "Teks Anda"
      : $("output").value === rawText
        ? "Siap diedit"
        : "Sudah diedit";
  controls();
});
$("copyButton").addEventListener("click", async () => {
  const text = $("output").value;
  if (!text.trim() || busy) return;
  try {
    await navigator.clipboard.writeText(text);
    message("Teks sudah disalin ke clipboard.");
  } catch {
    $("output").focus();
    $("output").select();
    message(
      "Browser belum mengizinkan penyalinan. Teks sudah dipilih; tekan Ctrl+C atau gunakan menu Salin.",
    );
  }
});
$("downloadButton").addEventListener("click", () => {
  if (!$("output").value.trim() || busy) return;
  const url = URL.createObjectURL(
    new Blob([$("output").value], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadName(file?.name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message("File .txt dibuat dari teks yang sedang tampil.");
});
$("exampleButton").addEventListener("click", async () => {
  const token = version;
  try {
    const response = await fetch(
      new URL("examples/indonesian-receipt.png", base),
    );
    if (!response.ok) throw new Error("Contoh tidak tersedia.");
    const blob = await response.blob();
    if (token !== version) return;
    await selectFile(
      new File([blob], "contoh-nota-sintetis.png", { type: "image/png" }),
    );
  } catch {
    $("errorText").textContent =
      "Contoh gambar tidak dapat dimuat. Anda tetap bisa memilih gambar sendiri.";
    $("errorBox").hidden = false;
  }
});
for (const type of ["dragenter", "dragover"])
  $("dropzone").addEventListener(type, (event) => {
    event.preventDefault();
    $("dropzone").classList.add("drag-over");
  });
$("dropzone").addEventListener("dragleave", (event) => {
  if (!$("dropzone").contains(event.relatedTarget))
    $("dropzone").classList.remove("drag-over");
});
$("dropzone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("dropzone").classList.remove("drag-over");
  void selectFile(event.dataTransfer.files[0]);
});
window.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files"))
    event.preventDefault();
});
window.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files.length) event.preventDefault();
});
document.addEventListener("paste", (event) => {
  if (
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLInputElement ||
    event.target.isContentEditable
  )
    return;
  const image = Array.from(event.clipboardData?.items || []).find(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
  if (image) {
    event.preventDefault();
    void selectFile(image.getAsFile());
  }
});
let theme = "light";
try {
  theme =
    localStorage.getItem("bacagambar-theme") === "dark" ? "dark" : "light";
} catch {
  /* Storage can be disabled by the browser. */
}
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $("themeButton").textContent =
    theme === "light" ? "Mode gelap" : "Mode terang";
}
$("themeButton").addEventListener("click", () => {
  theme = theme === "light" ? "dark" : "light";
  applyTheme();
  try {
    localStorage.setItem("bacagambar-theme", theme);
  } catch {
    /* The current tab still changes theme. */
  }
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) {
    cancelJob();
    controls();
  } else void engine.dispose();
});
applyTheme();
controls();
