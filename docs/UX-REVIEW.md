# Tinjauan UX

**PASS untuk alur yang diuji, 31 Oktober 2026.** Aplikasi dipakai sebagai meja kerja dokumen: sumber di kiri dan editor hasil di kanan, lalu ditumpuk di layar kecil. Tampilan terang mengikuti pilihan aplikasi kerja pada sesi ini; tema gelap tetap tersedia. Dial yang dipakai adalah ENERGY 1 / RHYTHM 2 / MOTION 1.

## Hard Gate: PASS

Teks dan skor pada screenshot berasal dari Tesseract nyata pada fixture sintetis. Skor disebut skor mesin, bukan persentase akurasi. [Ringkasan browser](evidence/windows-browser-summary.json) mencatat 13 kasus lulus dan 127 request HTTP, tanpa unggahan atau origin pihak ketiga. Native file picker menjadi alternatif keyboard untuk drag/drop. Pesan kosong, progres, pembatalan dan error tersedia; fatal initialization menyediakan tombol muat ulang yang benar-benar bekerja.

## Purpose-Gate: PASS

Warna hijau tua membedakan aksi utama dari kertas dan editor; latar hangat dipakai untuk kegiatan membaca. Monospace hanya dipakai pada hasil untuk mempertahankan spasi/baris OCR. Satu bayangan pada pratinjau memisahkan kertas dari alas. Tidak ada logo, foto, statistik pelanggan, dekorasi bergerak atau navigasi tambahan. Tiga screenshot memperlihatkan nota Indonesia, catatan Inggris dalam tema gelap, dan hasil pada ponsel.

## Liveliness: PASS

Identitas berasal dari pekerjaan gambar-ke-teks: pratinjau kertas, dua langkah, bahasa/rotasi di dekat sumber, dan ekspor di dekat editor. Hierarki fokus pada pemilihan gambar, pembacaan, lalu hasil. Gerakan dibatasi pada feedback kontrol, dan dihentikan pada prefers-reduced-motion. Susunan berubah mengikuti ruang, bukan sekadar mengecilkan desktop.

## Craftsmanship: PASS

Suite [browser](../tests/browser/ocr.spec.js) memeriksa OCR nyata, edit, clipboard, unduhan UTF-8, rotasi, pembatalan, pergantian file, paste/drop, reload setelah gangguan, keyboard, lima lebar dan dua tema. [Tinjauan layout](evidence/layout-review.json) menambah 20 keadaan, termasuk ukuran teks 200 persen, tanpa overflow horizontal. Warna normal pada putih memiliki rasio 12,84:1, teks pendukung 6,12:1, teks tombol utama 8,29:1; teks pendukung gelap pada permukaan gelap 9,04:1. Rasio dihitung dengan formula WCAG, dan fokus terlihat serta target tombol minimal 44 piksel diperiksa di browser.

Lingkup ini tidak mengesahkan seluruh browser/perangkat atau akurasi untuk setiap dokumen. Input tulisan tangan, blur, tabel rumit dan angka tetap perlu diperiksa pengguna. Tidak ada klaim SLA atau benchmark kecepatan.
