"""Render non-sensitive printed-text OCR fixtures with an existing Pillow install."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

from PIL import Image, ImageDraw, ImageFont, __version__ as pillow_version


ROOT = Path(__file__).resolve().parents[1]
RECEIPT_TEXT = """TOKO KERTAS MEJA
NOTA PEMBELIAN
31 OKTOBER 2026
Nomor: OCR-1042
BUKU TULIS 2 x Rp8.000
PULPEN BIRU 1 x Rp4.000
TOTAL Rp20.000
Pembayaran: TUNAI
Terima kasih."""
NOTE_TEXT = """PROJECT MEETING NOTES
Date: 31 October 2026
The inventory API is ready for review.
Add a health check before deployment.
Keep a backup before moving files.
Next review: Monday at 09:30."""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def default_font(bold: bool = False) -> Path:
    candidates = (
        [Path("C:/Windows/Fonts/arialbd.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")]
        if bold else
        [Path("C:/Windows/Fonts/arial.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("No fixture font found. Supply --font and --bold-font paths.")


def receipt(regular: Path, bold: Path) -> Image.Image:
    image = Image.new("RGB", (850, 1_000), "white")
    draw = ImageDraw.Draw(image)
    left = 65
    lines = [
        (70, "TOKO KERTAS MEJA", 45, bold),
        (137, "NOTA PEMBELIAN", 32, regular),
        (245, "31 OKTOBER 2026", 32, regular),
        (305, "Nomor: OCR-1042", 32, regular),
        (400, "BUKU TULIS 2 x Rp8.000", 32, regular),
        (460, "PULPEN BIRU 1 x Rp4.000", 32, regular),
        (580, "TOTAL Rp20.000", 43, bold),
        (675, "Pembayaran: TUNAI", 32, regular),
        (790, "Terima kasih.", 34, regular),
    ]
    for y, text, size, font_path in lines:
        font = ImageFont.truetype(str(font_path), size)
        if draw.textbbox((left, y), text, font=font)[2] > image.width - left:
            raise ValueError(f"Fixture font makes receipt line overflow: {text}")
        draw.text((left, y), text, font=font, fill="#171717")
    draw.line((left, 205, image.width - left, 205), fill="#a0a0a0", width=2)
    draw.line((left, 540, image.width - left, 540), fill="#a0a0a0", width=2)
    return image


def note(regular: Path, bold: Path, transparent: bool = False) -> Image.Image:
    image = Image.new("RGBA" if transparent else "RGB", (1_200, 820),
                      (255, 255, 255, 0) if transparent else "white")
    draw = ImageDraw.Draw(image)
    for index, text in enumerate(NOTE_TEXT.splitlines()):
        font = ImageFont.truetype(str(bold if index == 0 else regular), 44 if index == 0 else 36)
        y = 75 if index == 0 else 200 + (index - 1) * 90
        if draw.textbbox((70, y), text, font=font)[2] > image.width - 70:
            raise ValueError(f"Fixture font makes note line overflow: {text}")
        draw.text((70, y), text, font=font, fill="#171717")
    return image


def png_chunk(name: bytes, data: bytes = b"") -> bytes:
    return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path)
    parser.add_argument("--bold-font", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "tests" / "fixtures")
    args = parser.parse_args()
    regular = (args.font or default_font()).resolve(strict=True)
    bold = (args.bold_font or default_font(bold=True)).resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cases: list[dict] = []

    def record(identifier: str, filename: str, mime: str, image: Image.Image | None,
               expected_text: str = "", fragments: list[str] | None = None, **metadata) -> None:
        item = {"id": identifier, "file": filename, "mime": mime, "valid": True,
                "expectedText": expected_text, "requiredFragments": fragments or [], **metadata}
        if image is not None:
            item.update(width=image.width, height=image.height)
        item.update(bytes=(output / filename).stat().st_size, sha256=sha256(output / filename))
        cases.append(item)

    receipt_image = receipt(regular, bold)
    receipt_fragments = ["toko kertas meja", "nota pembelian", "ocr-1042", "buku tulis", "pulpen biru", "20.000", "terima kasih"]
    receipt_image.save(output / "indonesian-receipt.png", compress_level=9)
    record("indonesian-receipt", "indonesian-receipt.png", "image/png", receipt_image,
           RECEIPT_TEXT, receipt_fragments, language="ind")

    sideways = receipt_image.transpose(Image.Transpose.ROTATE_90)
    sideways.save(output / "indonesian-receipt-sideways.png", compress_level=9)
    record("indonesian-sideways", "indonesian-receipt-sideways.png", "image/png", sideways,
           RECEIPT_TEXT, receipt_fragments, language="ind", rotationToUpright=90)

    note_image = note(regular, bold)
    note_fragments = ["project meeting notes", "31 october 2026", "inventory api", "health check", "backup", "09:30"]
    note_image.save(output / "english-note.jpg", quality=94, subsampling=0)
    record("english-jpeg", "english-note.jpg", "image/jpeg", note_image, NOTE_TEXT,
           note_fragments, language="eng")

    note_image.save(output / "english-note.webp", lossless=True, quality=100, method=6)
    record("english-webp", "english-note.webp", "image/webp", note_image, NOTE_TEXT,
           note_fragments, language="eng")

    transparent_note = note(regular, bold, transparent=True)
    transparent_note.save(output / "english-note-transparent.png", compress_level=9)
    record("english-transparent", "english-note-transparent.png", "image/png", transparent_note,
           NOTE_TEXT, note_fragments, language="eng", requiresWhiteFlatten=True)

    oriented = note_image.transpose(Image.Transpose.ROTATE_90)
    exif = Image.Exif()
    exif[274] = 6
    oriented.save(output / "english-note-exif.jpg", quality=94, subsampling=0, exif=exif)
    record("english-exif", "english-note-exif.jpg", "image/jpeg", oriented, NOTE_TEXT,
           note_fragments, language="eng", exifOrientation=6,
           displayWidth=note_image.width, displayHeight=note_image.height)

    blank = Image.new("RGB", (800, 600), "white")
    blank.save(output / "blank.png", compress_level=9)
    record("blank", "blank.png", "image/png", blank, expectEmpty=True)

    (output / "corrupt.png").write_bytes(b"\x89PNG\r\n\x1a\nnot-a-complete-PNG")
    record("corrupt", "corrupt.png", "image/png", None, valid=False, rejectCode="invalid-image")

    header = struct.pack(">IIBBBBB", 100_000, 100_000, 8, 2, 0, 0, 0)
    (output / "huge-header.png").write_bytes(
        b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IEND"))
    record("huge-header", "huge-header.png", "image/png", None, valid=False,
           width=100_000, height=100_000, rejectCode="dimensions-too-large",
           note="Header-only invalid PNG. No large pixel buffer is allocated during generation.")

    first = Image.new("RGB", (32, 32), "white")
    second = Image.new("RGB", (32, 32), "black")
    first.save(output / "animated.webp", save_all=True, append_images=[second],
               duration=100, loop=0, lossless=True)
    record("animated-webp", "animated.webp", "image/webp", first, valid=False, rejectCode="animated-image")

    (output / "unsupported.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="5" y="25">TEST</text></svg>\n',
        encoding="utf-8")
    record("unsupported-svg", "unsupported.svg", "image/svg+xml", None, valid=False,
           rejectCode="unsupported-type")

    manifest = {
        "schema": 1,
        "description": "Synthetic, non-sensitive OCR fixtures rendered from text with standard fonts. No uploaded personal documents are used.",
        "generator": "scripts/generate-fixtures.py",
        "pillowVersion": pillow_version,
        "fonts": [{"file": path.name, "sha256": sha256(path)} for path in (regular, bold)],
        "assertion": "Normalize recognized text to lowercase and collapse whitespace before checking requiredFragments. These fragments are test expectations, never recognition output.",
        "reproduction": "Committed images are fixed fixtures. Regeneration needs Pillow and the same font files/versions for identical rendering; fonts are not redistributed.",
        "cases": cases,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(cases)} synthetic fixtures in {output}")


if __name__ == "__main__":
    main()
