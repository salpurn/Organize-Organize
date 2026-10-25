# Organize-Organize
Aplikasi web untuk mengubah dokumen tidak terstruktur (teks atau CSV) menjadi data terstruktur yang siap dimasukkan ke database, lengkap dengan export ke SQL dan JSON.

Project ini dibuat sebagai Capstone Project bootcamp IBM Bob, dengan kode yang dihasilkan menggunakan IBM Bob melalui teknik prompt layering (3 layer).

## Fitur

- **Upload dokumen**: unggah file `.txt` / `.csv` (drag-and-drop) atau tempel teks secara langsung
- **Ekstraksi otomatis**: mendeteksi nama, email, nomor telepon, tanggal, dan nominal uang menggunakan Regular Expression
- **Normalisasi data**:
  - Telepon → `08xxxxxxxxxx` (awalan `+62` / `62` diubah menjadi `0`)
  - Nominal → angka murni (`Rp 2,500,000` → `2500000`)
  - Tanggal → `YYYY-MM-DD` (`12/10/2026` → `2026-10-12`)
- **Tabel yang dapat diedit**: koreksi hasil ekstraksi langsung di tabel
- **Schema mapping**: atur nama kolom dan tipe data (`VARCHAR`, `INT`, `DATE`, `DECIMAL`)
- **Database lokal**: simpan data dengan fitur CRUD (localStorage)
- **Export**: hasilkan perintah SQL (`CREATE TABLE` & `INSERT INTO`) dan file JSON

## Alur Penggunaan

1. **Upload**: unggah file atau tempel teks dokumen
2. **Extract**: data diekstrak dan dinormalisasi secara otomatis
3. **Map Schema**: sesuaikan nama kolom dan tipe data
4. **Export**: simpan ke database lokal atau unduh sebagai SQL / JSON

## Tech Stack

- HTML5 (semantik)
- Tailwind CSS (via CDN)
- Vanilla JavaScript (tanpa framework/library)
- localStorage sebagai penyimpanan lokal

## Cara Menjalankan

Tidak perlu instalasi atau backend.

```bash
git clone https://github.com/salpurn/Organize-Organize.git
cd .\Organize-Organize\
```

Lalu buka `index.html` langsung di browser, atau jalankan dengan ekstensi **Live Server** di VS Code / IBM Bob.

## Struktur Project

```
├── index.html      # Struktur halaman dan komponen UI
├── style.css       # Styling tambahan di luar Tailwind
├── script.js       # Logika ekstraksi, normalisasi, CRUD, dan export
├── sample-data/    # File CSV untuk pengujian
│   ├── 01_kontak_pelanggan_clean.csv
│   ├── 02_invoice_penjualan.csv
│   └── 03_data_berantakan_edge_case.csv
└── README.md
```

## Data Uji

| File | Tujuan |
|---|---|
| `01_kontak_pelanggan_clean.csv` | Data rapi untuk menguji alur dasar |
| `02_invoice_penjualan.csv` | Data invoice dengan nominal Rupiah |
| `03_data_berantakan_edge_case.csv` | Data dengan format tidak seragam untuk menguji normalisasi |

## Keterbatasan

- Ekstraksi masih berbasis pola (Regular Expression), sehingga hanya efektif untuk format yang sudah dikenali.
- Nominal dengan angka desimal (misalnya `Rp 10.000.000,50`) belum ditangani secara tepat.
- Data tersimpan di localStorage, sehingga hanya tersedia di browser yang sama.

## Rencana Pengembangan

- Confidence Score untuk menandai data yang valid, meragukan, atau kosong
- Validasi email yang lebih ketat dan deteksi data duplikat
- Integrasi dengan IBM watsonx.ai melalui backend untuk ekstraksi dokumen berformat bebas
- Koneksi langsung ke database (IBM Db2, PostgreSQL, MySQL)
- Dukungan file PDF dan hasil scan (OCR), serta batch processing
