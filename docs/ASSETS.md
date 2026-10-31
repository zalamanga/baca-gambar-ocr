# Aset OCR dan perilaku jaringan

`npm run prepare:assets` menyalin aset dari dependensi lokal ke `public/ocr/` dan dua gambar contoh ke `public/examples/`. Model bahasa didekompresi dengan `node:zlib` menjadi `.traineddata`. Perintah ini tidak mengunduh aset. Kedua folder hasil tersebut diabaikan Git dan disertakan Vite dalam hasil build. Versi dependensi diperiksa terhadap `package-lock.json`; build berhenti jika versi atau berkas tidak sesuai.

| Sumber | Versi | Berkas yang digunakan |
| --- | --- | --- |
| [Tesseract.js](https://github.com/naptha/tesseract.js) / [paket npm](https://www.npmjs.com/package/tesseract.js/v/7.0.0) | 7.0.0 | `dist/worker.min.js` dan lisensi |
| [Tesseract.js Core](https://github.com/naptha/tesseract.js-core) / [paket npm](https://www.npmjs.com/package/tesseract.js-core/v/7.0.0) | 7.0.0 | Core LSTM biasa, SIMD, dan relaxed SIMD |
| [Data bahasa Tesseract.js](https://github.com/naptha/tessdata) / [eng](https://www.npmjs.com/package/@tesseract.js-data/eng/v/1.0.0), [ind](https://www.npmjs.com/package/@tesseract.js-data/ind/v/1.0.0) | 1.0.0 | `4.0.0_best_int/{eng,ind}.traineddata.gz` |
| [Fixture proyek](../tests/fixtures/manifest.json) | Tetap di repositori | `indonesian-receipt.png`, `english-note.jpg` |

Gambar contoh dibuat dari teks fiktif untuk pengujian. Gambar tersebut bukan dokumen pengguna. Manifest fixture mencatat teks sumber, ukuran, hash, dan cara reproduksi. Font yang dipakai generator tidak ikut didistribusikan.

Manifest hasil `public/ocr/asset-manifest.json` mencatat sumber berkas, URL relatif, ukuran, hash SHA-256, versi paket, dan deklarasi lisensi paket. Entri model juga mencatat operasi `gunzip`, ukuran/hash gzip sumber, dan ukuran/hash model mentah yang disajikan. Tesseract.js dan Core mendeklarasikan Apache-2.0. Kedua paket data bahasa mendeklarasikan MIT pada metadata paket npm. Teks lisensi engine dan pemberitahuan lisensi worker ikut disalin ke hasil build; sumber data bahasa ditautkan di tabel.

## URL saat aplikasi berjalan

Semua URL dibentuk dari `import.meta.env.BASE_URL` dan origin halaman:

```text
ocr/worker/worker.min.js
ocr/core/tesseract-core-lstm.wasm.js
ocr/core/tesseract-core-simd-lstm.wasm.js
ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js
ocr/lang/eng.traineddata
ocr/lang/ind.traineddata
examples/indonesian-receipt.png
examples/english-note.jpg
```

Tesseract memilih satu core LSTM sesuai kemampuan browser. Pada versi 7, berkas `.wasm.js` sudah memuat biner WebAssembly di dalamnya. Pasangan `.js` dan `.wasm` dari paket yang sama juga tersedia dalam hasil build, tetapi pemuat browser normal menggunakan `.wasm.js`. `corePath` harus menunjuk ke direktori `ocr/core`, bukan memaksa satu varian. `workerPath` dan `langPath` diatur secara eksplisit agar default CDN Tesseract tidak digunakan. Opsi `gzip: false` membuat Tesseract meminta model `.traineddata` mentah, yang disajikan server lokal sebagai `application/octet-stream`.

| Model yang disajikan | Ukuran mentah | SHA-256 |
| --- | ---: | --- |
| `eng.traineddata` | 5.199.098 byte | `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747` |
| `ind.traineddata` | 1.776.253 byte | `431ad6931126cfd70a35db57eb14823c090fc6174e0eaf1f400dd06b9cb1baf3` |

Kedua model berjumlah 6.975.351 byte. Seluruh salinan aset dan dua contoh berjumlah sekitar 26,5 MiB, termasuk varian core yang tidak semuanya dimuat browser. URL `.gz` sengaja tidak dipakai saat runtime: beberapa pengelola unduhan dapat mengambil alih URL arsip sehingga browser menerima respons kosong. Model mentah dengan nama tetap ini telah diuji melalui worker Tesseract nyata tanpa mengubah pengaturan sistem pengguna.

Konfigurasi Vite memakai `base: './'`, sehingga aset mengikuti lokasi halaman, termasuk subdirektori GitHub project Pages. Jalankan hasil build melalui HTTP, bukan membuka `index.html` sebagai `file://`.

## Privasi dan koneksi

Pemilihan gambar, persiapan gambar, dan OCR dilakukan di browser. Aplikasi ini tidak memiliki API unggah dan tidak mengirim gambar atau teks OCR ke server. Server hosting tetap menerima permintaan berkas aplikasi, worker, core, model bahasa, dan contoh yang dipilih, beserta informasi HTTP biasa seperti alamat IP. Pengelola hosting dapat mencatat permintaan tersebut.

Pada kunjungan web pertama, browser perlu mengambil halaman dan aset dari situs yang sama. Core dan model bahasa dimuat saat OCR diperlukan. Model berukuran beberapa megabita, sehingga pembacaan pertama dapat lebih lama. Cache browser dapat mengurangi unduhan berikutnya, tetapi tidak menjamin situs tersedia tanpa koneksi. Proyek ini tidak memasang service worker dan tidak menjanjikan mode offline untuk situs publik.

Untuk penggunaan lokal, setelah `npm ci` berhasil mengambil seluruh dependensi, build dan server lokal dapat berjalan tanpa internet. [Start.ps1](../scripts/Start.ps1) menjalankan `npm ci` jika dependensi belum sesuai, membuat build, lalu menjalankan [serve.py](../scripts/serve.py) di `127.0.0.1:8124`. Server hanya menyajikan hasil build melalui GET/HEAD, menolak metode tulis, dan tidak menampilkan daftar direktori.

Skrip mulai memerlukan Node.js 22.12 atau lebih baru dan Python 3.9 atau lebih baru. Cache npm, berkas sementara, dan cache bytecode Python diarahkan ke `.local/` dalam proyek melalui variabel lingkungan proses; nilai sebelumnya dipulihkan ketika skrip selesai. Skrip tidak memasang alat global atau mengubah pengaturan sistem.
