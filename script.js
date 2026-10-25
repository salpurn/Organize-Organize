/**
 * Document to Database AI — script.js
 * Handles: FileReader upload, regex extraction, inline editing,
 * schema mapping, localStorage CRUD, SQL/JSON export.
 */

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let currentStep = 1;
let rawText = '';           // Raw document text from file or paste
let extractedRows = [];     // Array of objects: [{fieldName: value, ...}]
let extractedFields = [];   // Column names detected
let schemaMap = [];         // [{original, column, type, include}]
let currentTableName = '';  // Active table name for export/save

// ─────────────────────────────────────────────
// REGEX PATTERNS for smart field extraction
// Each pattern: { name, regex, type }
// ─────────────────────────────────────────────
const FIELD_PATTERNS = [
  // Email — standard RFC-like pattern
  { name: 'email',   regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/gi,          type: 'VARCHAR' },

  // Phone — handles Indonesian (+62, 62, 08) and international formats:
  //   +62 812-3456-7890 | (021) 1234-5678 | 08123 456 789 | 0812.345.6789
  //   Captured digits are normalized to 08xxxxxxxxxx by normalizePhone().
  { name: 'phone',
    regex: /(?:\+62|62|0)[\s\-.]?(?:\(?\d{2,4}\)?[\s\-.]?)?\d{3,4}[\s\-.]?\d{3,4}[\s\-.]?\d{0,4}/g,
    type: 'VARCHAR' },

  // Amount — Indonesian Rupiah and generic currency:
  //   Rp1.234.567 | Rp. 500.000 | Rp 1,234,567.00 | IDR 50000 | 1.500.000
  //   Captured text is normalized to a plain decimal by normalizeAmount().
  { name: 'amount',
    regex: /(?:IDR|Rp\.?\s*)\s*[\d.,]+|(?<!\w)\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?\b/g,
    type: 'DECIMAL' },

  // ISO / year-first date: 2024-01-15 or 2024/01/15
  //   Normalized to YYYY-MM-DD; invalid calendar dates are cleared.
  { name: 'date',
    regex: /\b\d{4}[-\/]\d{2}[-\/]\d{2}\b/g,
    type: 'DATE' },

  // Local / day-first date: 15-01-2024 | 15/01/2024 | 15.01.2024
  //   Normalized to YYYY-MM-DD; invalid calendar dates are cleared.
  { name: 'date_local',
    regex: /\b\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{4}\b/g,
    type: 'DATE' },

  // Full name — "Name: John Doe" or "Nama: Budi Santoso"
  { name: 'name',    regex: /(?:(?:Full\s*)?Name|Nama)\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi, type: 'VARCHAR', captureGroup: 1 },
  // Address
  { name: 'address', regex: /(?:Address|Alamat)\s*[:\-]\s*(.+)/gi,                                type: 'VARCHAR', captureGroup: 1 },
  // Numeric ID / Invoice number
  { name: 'invoice_no', regex: /(?:Invoice\s*(?:No\.?|Number|#)|Order\s*(?:ID|No\.?))\s*[:\-]?\s*([A-Z0-9\-\/]+)/gi, type: 'VARCHAR', captureGroup: 1 },
];

// ─────────────────────────────────────────────
// VALUE NORMALIZERS
// Called after a raw match is captured to produce clean, canonical values.
// ─────────────────────────────────────────────

/**
 * Normalize a phone number string:
 * Replace +62 / +628 country-code prefix (with optional spaces) with 0,
 * then keep digits only.
 * e.g. "+62 812-3456-7890" → "081234567890"
 *      "+6281234567890"    → "081234567890"
 *      "0813 9876 5432"    → "081398765432"
 * @param {string} raw
 * @returns {string}
 */
function normalizePhone(raw) {
  // Strip all spaces first so "+62 812..." becomes "+62812..."
  const s = raw.replace(/\s/g, '');
  // Replace +62 country code (covers +628xx and +627xx etc.) with 0
  const stripped = s.startsWith('+62') ? '0' + s.slice(3) : s;
  // Keep digits only
  return stripped.replace(/\D/g, '');
}

/**
 * Normalize a currency/amount string: strip everything except digits and
 * a leading minus sign (to preserve negative values).
 * Removes Rp, IDR, dots, commas, spaces — returns bare integer string.
 * @param {string} raw
 * @returns {string}
 */
function normalizeAmount(raw) {
  // Preserve minus sign wherever it appears in the string (e.g. "Rp -75.000" or "-Rp500")
  const negative = raw.includes('-');
  const digits   = raw.replace(/[^0-9]/g, '');
  return digits ? (negative ? '-' + digits : digits) : '';
}

/**
 * Normalize various date formats to ISO 8601 YYYY-MM-DD.
 * Accepts: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (day-first)
 *          YYYY/MM/DD, YYYY-MM-DD (year-first)
 * Returns empty string for invalid calendar dates (e.g. 32/01/2024, 29/02/2023).
 * @param {string} raw
 * @returns {string}
 */
function normalizeDate(raw) {
  let year, month, day;

  // Year-first: YYYY[-/]MM[-/]DD
  const isoMatch = raw.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
  if (isoMatch) {
    [, year, month, day] = isoMatch.map(Number);
  } else {
    // Day-first: DD[-/.]MM[-/.]YYYY (4-digit year required)
    const localMatch = raw.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})$/);
    if (!localMatch) return '';
    [, day, month, year] = localMatch.map(Number);
  }

  // Validate calendar ranges
  if (month < 1 || month > 12) return '';
  if (day   < 1 || day   > 31) return '';

  // Build a real Date object to catch impossible combos (e.g. Feb 30)
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return ''; // Date rolled over — invalid
  }

  // Return zero-padded ISO string
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Dispatch to the right normalizer based on field name.
 * Handles both English pattern names (phone/amount/date) and
 * Indonesian CSV/KV keys (telepon/nominal/tanggal).
 * @param {string} fieldName
 * @param {string} value
 * @returns {string}
 */
function normalizeValue(fieldName, value) {
  if (!value) return value;
  const f = fieldName.toLowerCase();
  // Phone: pattern names + common Indonesian/CSV column names
  if (f === 'phone' || /telepon|telp|hp|handphone|no_hp|no_telp/.test(f)) {
    return normalizePhone(value);
  }
  // Amount: pattern names + common Indonesian/CSV column names
  if (f === 'amount' || /nominal|harga|total|biaya|bayar|tagihan|price/.test(f)) {
    return normalizeAmount(value);
  }
  // Date: pattern names + common Indonesian/CSV column names
  if (f === 'date' || f === 'date_local' || /^tgl|tanggal|tanggal_lahir|tgl_lahir/.test(f)) {
    return normalizeDate(value);
  }
  return value;
}

// ─────────────────────────────────────────────
// STEP NAVIGATION
// ─────────────────────────────────────────────

/**
 * Navigate to a specific step, updating the stepper UI and section visibility.
 * @param {number} step - Target step number (1–4)
 */
function goToStep(step) {
  // Validate step bounds
  if (step < 1 || step > 4) return;

  currentStep = step;

  // Toggle section visibility
  for (let i = 1; i <= 4; i++) {
    const section = document.getElementById(`step-${i}`);
    if (section) section.classList.toggle('hidden', i !== step);
  }

  // Update stepper circles and lines
  document.querySelectorAll('.stepper-step').forEach(el => {
    const s = parseInt(el.dataset.step);
    const circle = el.querySelector('.step-circle');
    const label = el.querySelector('.step-label');

    circle.classList.remove('active', 'completed');
    label.classList.remove('active', 'completed');

    if (s < step) {
      circle.classList.add('completed');
      label.classList.add('completed');
      // Replace number with checkmark
      circle.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`;
    } else if (s === step) {
      circle.classList.add('active');
      label.classList.add('active');
      circle.textContent = s;
    } else {
      circle.textContent = s;
    }
  });

  // Update step connector lines
  for (let i = 1; i <= 3; i++) {
    const line = document.querySelector(`.step-line-${i}`);
    if (line) line.classList.toggle('completed', i < step);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─────────────────────────────────────────────
// STEP 1: FILE UPLOAD & DRAG-DROP
// ─────────────────────────────────────────────

function handleDragOver(event) {
  event.preventDefault();
  document.getElementById('drop-zone').classList.add('drag-over');
}

function handleDragLeave(event) {
  document.getElementById('drop-zone').classList.remove('drag-over');
}

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) readFile(file);
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) readFile(file);
}

/**
 * Read file content using FileReader API.
 * Populates rawText and shows the paste area for confirmation.
 * @param {File} file
 */
function readFile(file) {
  const allowedTypes = ['text/plain', 'text/csv', 'application/vnd.ms-excel'];
  const allowedExts = ['.txt', '.csv'];
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

  if (!allowedTypes.includes(file.type) && !allowedExts.includes(ext)) {
    showToast('⚠️', 'Only .txt and .csv files are supported.');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    rawText = e.target.result;
    document.getElementById('paste-area').value = rawText;
    document.getElementById('file-name-display').textContent = `${file.name} (${formatBytes(file.size)})`;
    document.getElementById('file-info').classList.remove('hidden');
  };
  reader.onerror = () => showToast('❌', 'Failed to read file.');
  reader.readAsText(file);
}

function clearFile() {
  rawText = '';
  document.getElementById('paste-area').value = '';
  document.getElementById('file-info').classList.add('hidden');
  document.getElementById('file-input').value = '';
}

/** Format bytes to human-readable size */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─────────────────────────────────────────────
// STEP 2: EXTRACT DATA
// ─────────────────────────────────────────────

function proceedToExtract() {
  rawText = document.getElementById('paste-area').value.trim();
  if (!rawText) {
    showToast('⚠️', 'Please upload a file or paste some text first.');
    return;
  }

  goToStep(2);

  // Show loading animation briefly for UX realism
  const loading = document.getElementById('extract-loading');
  loading.classList.remove('hidden');
  document.getElementById('extract-stats').classList.add('hidden');
  document.getElementById('extract-table-container').classList.add('hidden');
  document.getElementById('extract-actions').classList.add('hidden');
  document.getElementById('no-data-msg').classList.add('hidden');

  setTimeout(() => {
    loading.classList.add('hidden');
    const result = extractData(rawText);
    renderExtractTable(result.fields, result.rows);
  }, 900); // Simulate processing delay
}

/**
 * Core extraction engine.
 * Detects if content is CSV or free-form text and delegates accordingly.
 * Returns { fields: string[], rows: object[] }
 * @param {string} text
 */
function extractData(text) {
  // Normalize line endings and curly/smart quotes → straight ASCII quotes.
  // Keep straight quotes intact here so splitCsvLine can use them to protect
  // fields that contain commas (e.g. "Rp 2,500,000").
  const normalized = text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
  const lines = normalized.split('\n').filter(l => l.trim());
  if (lines.length > 1) {
    const delimiter = detectCsvDelimiter(lines[0]);
    if (delimiter && lines[0].split(delimiter).length >= 2) {
      return extractFromCSV(normalized, delimiter);
    }
  }
  return extractFromFreeText(normalized);
}

/**
 * Detect CSV delimiter: comma, semicolon, or tab.
 * Returns the most-likely delimiter char or null.
 * @param {string} headerLine
 */
function detectCsvDelimiter(headerLine) {
  const counts = {
    ',': (headerLine.match(/,/g) || []).length,
    ';': (headerLine.match(/;/g) || []).length,
    '\t': (headerLine.match(/\t/g) || []).length,
  };
  const max = Math.max(...Object.values(counts));
  if (max === 0) return null;
  return Object.keys(counts).find(k => counts[k] === max);
}

/**
 * Parse structured CSV text into rows and fields.
 * @param {string} text
 * @param {string} delimiter
 */
function extractFromCSV(text, delimiter) {
  // Normalize line endings; curly quotes already converted to straight by extractData.
  // Do NOT strip quotes here — splitCsvLine needs them to protect comma-containing fields.
  const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n').filter(l => l.trim());
  // Strip any residual quotes from header names only
  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/"/g, ''));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    let cols = splitCsvLine(lines[i], delimiter);

    // If the row has more columns than headers, extra splits likely came from an
    // unquoted currency value like "Rp 2,500,000" being split on its commas.
    // Merge overflow columns back into the last expected column by joining with
    // the delimiter so normalizeAmount can strip them all.
    if (cols.length > headers.length) {
      const overflow = cols.splice(headers.length - 1); // everything from last expected col onward
      cols.push(overflow.join(delimiter));               // rejoin as one field
    }

    // Pad missing columns with '' — never drop a row due to column count mismatch
    const row = {};
    headers.forEach((h, idx) => {
      // Strip quotes from each cell value after splitting (safe — field boundaries already resolved)
      const raw = (cols[idx] ?? '').trim().replace(/"/g, '');
      // Normalize values whose column name matches a known pattern (phone/amount/date)
      row[h] = normalizeValue(h.toLowerCase().replace(/\s+/g, '_'), raw);
    });
    rows.push(row);
  }

  return { fields: headers, rows };
}

/**
 * Split a CSV line respecting quoted fields.
 * @param {string} line
 * @param {string} delimiter
 */
function splitCsvLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === delimiter && !inQuotes) { result.push(current); current = ''; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

/**
 * Extract structured key-value data from free-form text (invoices, forms, etc.).
 * Parses "Key: Value" lines and also applies regex patterns for known field types.
 * @param {string} text
 */
function extractFromFreeText(text) {
  const rows = [];
  const fields = new Set();

  // Split on blank lines to identify record blocks
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());

  blocks.forEach(block => {
    const row = {};
    const lines = block.split('\n').filter(l => l.trim());

    lines.forEach(line => {
      // Match "Key: Value" or "Key - Value" patterns
      const kvMatch = line.match(/^([A-Za-z0-9 _\-\/]+?)\s*[:–\-]\s*(.+)$/);
      if (kvMatch) {
        const key   = kvMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
        const value = normalizeValue(key, kvMatch[2].trim());
        if (value !== '') {
          row[key] = value;
          fields.add(key);
        }
      }
    });

    // Apply regex patterns to the whole block for additional field detection
    FIELD_PATTERNS.forEach(pattern => {
      // Skip if already captured by key-value parsing for common fields
      if (row[pattern.name]) return;

      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(block)) !== null) {
        const raw = pattern.captureGroup ? match[pattern.captureGroup] : match[0];
        // Normalize the captured value (phone → 08x, amount → decimal, date → YYYY-MM-DD)
        const value = normalizeValue(pattern.name, raw ? raw.trim() : '');
        if (value && !row[pattern.name]) {
          row[pattern.name] = value;
          fields.add(pattern.name);
        }
        break; // Take only first match per pattern per block
      }
    });

    if (Object.keys(row).length > 0) rows.push(row);
  });

  // If no blocks found, try single-pass line-by-line extraction as one row
  if (rows.length === 0) {
    const singleRow = {};
    const allLines = text.split('\n').filter(l => l.trim());
    allLines.forEach(line => {
      const kvMatch = line.match(/^([A-Za-z0-9 _\-\/]+?)\s*[:–\-]\s*(.+)$/);
      if (kvMatch) {
        const key   = kvMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
        const value = normalizeValue(key, kvMatch[2].trim());
        if (value !== '') {
          singleRow[key] = value;
          fields.add(key);
        }
      }
    });
    // Apply regex to whole text
    FIELD_PATTERNS.forEach(pattern => {
      if (singleRow[pattern.name]) return;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      const match = regex.exec(text);
      if (match) {
        const raw   = pattern.captureGroup ? match[pattern.captureGroup] : match[0];
        const value = normalizeValue(pattern.name, raw ? raw.trim() : '');
        if (value) { singleRow[pattern.name] = value; fields.add(pattern.name); }
      }
    });
    if (Object.keys(singleRow).length > 0) rows.push(singleRow);
  }

  return { fields: Array.from(fields), rows };
}

/**
 * Render the extracted data into the editable table in Step 2.
 * @param {string[]} fields
 * @param {object[]} rows
 */
function renderExtractTable(fields, rows) {
  extractedFields = fields;
  extractedRows = rows;

  const thead = document.getElementById('extract-thead');
  const tbody = document.getElementById('extract-tbody');

  if (!fields.length || !rows.length) {
    document.getElementById('no-data-msg').classList.remove('hidden');
    return;
  }

  // Build table head
  thead.innerHTML = `
    <tr>
      ${fields.map(f => `<th class="px-4 py-3 text-left whitespace-nowrap">${escapeHtml(f)}</th>`).join('')}
      <th class="px-4 py-3 text-center w-10">Del</th>
    </tr>`;

  // Build table body with inline-editable cells
  tbody.innerHTML = rows.map((row, rowIdx) => `
    <tr class="table-row hover:bg-slate-800/40 transition-colors">
      ${fields.map(field => `
        <td class="px-4 py-2.5">
          <div contenteditable="true"
               class="editable-cell min-w-16 rounded px-2 py-1 text-slate-300 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/60 focus:bg-slate-800 transition-all"
               data-row="${rowIdx}" data-field="${escapeHtml(field)}"
               onblur="updateCell(this)">${escapeHtml(row[field] ?? '')}</div>
        </td>`).join('')}
      <td class="px-4 py-2.5 text-center">
        <button onclick="deleteRow(${rowIdx})" class="text-slate-600 hover:text-red-400 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </td>
    </tr>`).join('');

  // Show stats
  document.getElementById('stat-rows').textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''}`;
  document.getElementById('stat-fields').textContent = `${fields.length} field${fields.length !== 1 ? 's' : ''}`;

  document.getElementById('extract-stats').classList.remove('hidden');
  document.getElementById('extract-table-container').classList.remove('hidden');
  document.getElementById('extract-actions').classList.remove('hidden');
}

/** Update in-memory row data when a cell loses focus */
function updateCell(el) {
  const rowIdx = parseInt(el.dataset.row);
  const field = el.dataset.field;
  extractedRows[rowIdx][field] = el.textContent.trim();
}

/** Delete a row from the table and in-memory array */
function deleteRow(rowIdx) {
  extractedRows.splice(rowIdx, 1);
  renderExtractTable(extractedFields, extractedRows);
}

/** Add a blank row to the extracted data */
function addNewRow() {
  const emptyRow = {};
  extractedFields.forEach(f => emptyRow[f] = '');
  extractedRows.push(emptyRow);
  renderExtractTable(extractedFields, extractedRows);
  // Focus the first cell of the new row
  setTimeout(() => {
    const cells = document.querySelectorAll(`[data-row="${extractedRows.length - 1}"]`);
    if (cells.length) cells[0].focus();
  }, 50);
}

// ─────────────────────────────────────────────
// STEP 3: SCHEMA MAPPING
// ─────────────────────────────────────────────

/** Allowed SQL data types for the dropdown */
const SQL_TYPES = ['VARCHAR', 'INT', 'BIGINT', 'DECIMAL', 'DATE', 'DATETIME', 'BOOLEAN', 'TEXT'];

// Render schema map when step 3 is entered
function renderSchemaMap() {
  const tbody = document.getElementById('schema-map-tbody');
  schemaMap = extractedFields.map(field => ({
    original: field,
    column: sanitizeColumnName(field),
    type: inferSqlType(field),
    include: true,
  }));

  tbody.innerHTML = schemaMap.map((item, idx) => `
    <tr class="table-row hover:bg-slate-800/40 transition-colors">
      <td class="px-4 py-3">
        <span class="text-slate-400 font-mono text-xs bg-slate-800 px-2 py-1 rounded">${escapeHtml(item.original)}</span>
      </td>
      <td class="px-4 py-3">
        <input type="text" value="${escapeHtml(item.column)}"
          class="schema-col-input bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 w-full transition-all"
          data-idx="${idx}" onchange="updateSchemaColumn(this)" />
      </td>
      <td class="px-4 py-3">
        <select class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 w-full transition-all"
          data-idx="${idx}" onchange="updateSchemaType(this)">
          ${SQL_TYPES.map(t => `<option value="${t}" ${t === item.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </td>
      <td class="px-4 py-3 text-center">
        <label class="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" class="sr-only peer" ${item.include ? 'checked' : ''}
            data-idx="${idx}" onchange="updateSchemaInclude(this)">
          <div class="toggle-bg w-9 h-5 rounded-full peer-focus:ring-2 peer-focus:ring-indigo-500/30 transition-all"></div>
        </label>
      </td>
    </tr>`).join('');
}

/** Convert a raw field name to a valid SQL column name */
function sanitizeColumnName(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^(\d)/, 'col_$1') || 'column';
}

/**
 * Infer an appropriate SQL type from the field name using heuristics.
 * @param {string} fieldName
 */
function inferSqlType(fieldName) {
  const name = fieldName.toLowerCase();
  if (/email/.test(name)) return 'VARCHAR';
  if (/phone|tel|fax/.test(name)) return 'VARCHAR';
  if (/amount|price|total|subtotal|tax|discount|fee|salary|cost/.test(name)) return 'DECIMAL';
  if (/date|dob|birth|created|updated|time/.test(name)) return 'DATE';
  if (/id$|_id|^id|number|no$|count|qty|quantity|age/.test(name)) return 'INT';
  if (/active|status|flag|enabled|verified/.test(name)) return 'BOOLEAN';
  if (/description|note|comment|address|remark|body|content/.test(name)) return 'TEXT';
  return 'VARCHAR';
}

/** Re-run type inference for all columns (Auto-Detect button) */
function autoDetectTypes() {
  schemaMap = schemaMap.map(item => ({
    ...item,
    type: inferSqlType(item.original),
  }));
  renderSchemaMap();
  showToast('✨', 'Types auto-detected from field names.');
}

function updateSchemaColumn(el) {
  schemaMap[parseInt(el.dataset.idx)].column = el.value.trim() || schemaMap[parseInt(el.dataset.idx)].column;
}

function updateSchemaType(el) {
  schemaMap[parseInt(el.dataset.idx)].type = el.value;
}

function updateSchemaInclude(el) {
  schemaMap[parseInt(el.dataset.idx)].include = el.checked;
}

// ─────────────────────────────────────────────
// STEP 4: SAVE TO LOCAL DB & EXPORT
// ─────────────────────────────────────────────

/** Sync schemaMap from current DOM input/select values before saving */
function syncSchemaMapFromDOM() {
  document.querySelectorAll('.schema-col-input').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (schemaMap[idx]) schemaMap[idx].column = el.value.trim() || schemaMap[idx].column;
  });
  document.querySelectorAll('#schema-map-tbody select').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (schemaMap[idx]) schemaMap[idx].type = el.value;
  });
  document.querySelectorAll('#schema-map-tbody input[type="checkbox"]').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (schemaMap[idx]) schemaMap[idx].include = el.checked;
  });
}

/** Save the extracted + mapped data to localStorage */
function saveToDatabase() {
  if (!extractedRows.length) {
    showToast('⚠️', 'No data to save.');
    return;
  }

  // Sync any pending DOM changes before reading schemaMap
  syncSchemaMapFromDOM();

  currentTableName = document.getElementById('table-name-input').value.trim() || 'imported_data';
  // Sanitize table name
  currentTableName = currentTableName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

  const includedFields = schemaMap.filter(s => s.include);
  if (!includedFields.length) {
    showToast('⚠️', 'Include at least one column.');
    return;
  }

  // Build the table record
  const tableData = {
    name: currentTableName,
    schema: includedFields.map(s => ({ original: s.original, column: s.column, type: s.type })),
    rows: extractedRows.map(row => {
      const mapped = {};
      includedFields.forEach(s => {
        mapped[s.column] = row[s.original] ?? '';
      });
      return mapped;
    }),
    createdAt: new Date().toISOString(),
  };

  // Retrieve existing DB from localStorage
  const db = getLocalDB();
  // Check if table exists — update it
  const existingIdx = db.tables.findIndex(t => t.name === currentTableName);
  if (existingIdx >= 0) {
    db.tables[existingIdx] = tableData;
  } else {
    db.tables.push(tableData);
  }
  saveLocalDB(db);

  updateDbBadge();

  // Show success banner (do this before goToStep so step 4 has it ready)
  const banner = document.getElementById('save-success-banner');
  const msg = document.getElementById('save-success-msg');
  msg.textContent = `Table "${currentTableName}" saved with ${tableData.rows.length} record(s)!`;
  banner.classList.remove('hidden');

  // goToStep(4) via the patch will also call generateSQLPreview()
  goToStep(4);
}

// ─────────────────────────────────────────────
// SQL GENERATION
// ─────────────────────────────────────────────

/**
 * Generate CREATE TABLE and INSERT INTO SQL statements.
 * @returns {string} Full SQL script
 */
function generateSQL() {
  const db = getLocalDB();
  const table = db.tables.find(t => t.name === currentTableName);
  if (!table) return '-- No table found.';

  const { name, schema, rows } = table;

  // CREATE TABLE statement
  const colDefs = schema.map(col => {
    let typeStr = col.type;
    if (col.type === 'VARCHAR') typeStr = 'VARCHAR(255)';
    if (col.type === 'DECIMAL') typeStr = 'DECIMAL(15,2)';
    return `  \`${col.column}\` ${typeStr}`;
  });

  let sql = `-- Generated by Document to Database AI\n`;
  sql += `-- Created: ${new Date().toLocaleString()}\n\n`;
  sql += `CREATE TABLE IF NOT EXISTS \`${name}\` (\n`;
  sql += `  \`id\` INT AUTO_INCREMENT PRIMARY KEY,\n`;
  sql += colDefs.join(',\n') + '\n';
  sql += `);\n\n`;

  // INSERT INTO statements — one per row
  rows.forEach((row, idx) => {
    const cols = schema.map(col => `\`${col.column}\``).join(', ');
    const vals = schema.map(col => {
      const v = row[col.column];
      // Numbers and booleans without quotes; everything else quoted
      if (col.type === 'INT' || col.type === 'BIGINT') {
        const n = parseInt(v);
        return isNaN(n) ? 'NULL' : String(n);
      }
      if (col.type === 'DECIMAL') {
        const f = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
        return isNaN(f) ? 'NULL' : String(f);
      }
      if (col.type === 'BOOLEAN') {
        return /true|yes|1/i.test(String(v)) ? 'TRUE' : 'FALSE';
      }
      return v ? `'${String(v).replace(/'/g, "''")}'` : 'NULL';
    }).join(', ');

    sql += `INSERT INTO \`${name}\` (${cols})\nVALUES (${vals});\n`;
  });

  return sql;
}

function generateSQLPreview() {
  const sql = generateSQL();
  document.getElementById('sql-preview').textContent = sql;
  document.getElementById('sql-preview-container').classList.remove('hidden');
}

/** Download SQL file */
function exportSQL() {
  const sql = generateSQL();
  const blob = new Blob([sql], { type: 'text/sql' });
  downloadBlob(blob, `${currentTableName || 'export'}.sql`);
  showToast('⬇️', 'SQL file downloaded!');
  generateSQLPreview();
}

/** Download JSON file */
function exportJSON() {
  const db = getLocalDB();
  const table = db.tables.find(t => t.name === currentTableName);
  if (!table) { showToast('⚠️', 'No data to export.'); return; }

  const json = JSON.stringify(table.rows, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  downloadBlob(blob, `${currentTableName || 'export'}.json`);
  showToast('⬇️', 'JSON file downloaded!');
}

/** Copy SQL preview content to clipboard */
function copySQL() {
  const sql = document.getElementById('sql-preview').textContent;
  navigator.clipboard.writeText(sql).then(() => {
    const btn = document.getElementById('copy-sql-btn');
    btn.innerHTML = `<svg class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg> Copied!`;
    btn.classList.add('text-green-400');
    setTimeout(() => {
      btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg> Copy`;
      btn.classList.remove('text-green-400');
    }, 2000);
  }).catch(() => showToast('❌', 'Failed to copy to clipboard.'));
}

// ─────────────────────────────────────────────
// LOCAL DB (localStorage CRUD)
// ─────────────────────────────────────────────

const DB_KEY = 'doc2db_local_db';

function getLocalDB() {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY)) || { tables: [] };
  } catch {
    return { tables: [] };
  }
}

function saveLocalDB(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function updateDbBadge() {
  const db = getLocalDB();
  const badge = document.getElementById('db-count-badge');
  if (db.tables.length > 0) {
    badge.textContent = `${db.tables.length} table${db.tables.length !== 1 ? 's' : ''}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────
// DB MODAL
// ─────────────────────────────────────────────

function openDbModal() {
  const db = getLocalDB();
  const modal = document.getElementById('db-modal');
  const body = document.getElementById('db-modal-body');
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  if (!db.tables.length) {
    body.innerHTML = `<p class="text-slate-500 text-sm text-center py-8">No tables yet. Process a document to get started.</p>`;
    return;
  }

  body.innerHTML = db.tables.map((table, tIdx) => `
    <div class="mb-6 last:mb-0">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span class="text-white font-semibold font-mono">${escapeHtml(table.name)}</span>
          <span class="text-xs text-slate-500">${table.rows.length} row${table.rows.length !== 1 ? 's' : ''}</span>
          <span class="text-xs text-slate-600">${new Date(table.createdAt).toLocaleDateString()}</span>
        </div>
        <button onclick="deleteTable(${tIdx})" class="text-xs text-red-500 hover:text-red-400 transition-colors flex items-center gap-1">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          Delete
        </button>
      </div>
      <div class="overflow-x-auto rounded-xl border border-slate-800">
        <table class="w-full text-xs">
          <thead class="bg-slate-800 text-slate-400 uppercase tracking-wider">
            <tr>
              ${table.schema.map(col => `<th class="px-3 py-2 text-left whitespace-nowrap">${escapeHtml(col.column)}<span class="ml-1 text-slate-600">(${col.type})</span></th>`).join('')}
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            ${table.rows.slice(0, 5).map(row => `
              <tr class="hover:bg-slate-800/40">
                ${table.schema.map(col => `<td class="px-3 py-2 text-slate-400 whitespace-nowrap max-w-xs truncate">${escapeHtml(String(row[col.column] ?? ''))}</td>`).join('')}
              </tr>`).join('')}
            ${table.rows.length > 5 ? `<tr><td colspan="${table.schema.length}" class="px-3 py-2 text-slate-600 text-center">... and ${table.rows.length - 5} more rows</td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>`).join('');
}

function closeDbModal() {
  const modal = document.getElementById('db-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function deleteTable(tableIdx) {
  const db = getLocalDB();
  const name = db.tables[tableIdx]?.name;
  if (!confirm(`Delete table "${name}"? This cannot be undone.`)) return;
  db.tables.splice(tableIdx, 1);
  saveLocalDB(db);
  updateDbBadge();
  openDbModal(); // Refresh modal
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

/**
 * Trigger a browser file download from a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Escape HTML special characters to prevent XSS when injecting to innerHTML.
 * @param {string} str
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Show a toast notification.
 * @param {string} icon - Emoji icon
 * @param {string} message
 * @param {number} duration - ms before auto-hide
 */
function showToast(icon, message, duration = 3000) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-icon').textContent = icon;
  document.getElementById('toast-msg').textContent = message;
  toast.classList.remove('hidden');
  toast.classList.add('toast-enter');
  setTimeout(() => {
    toast.classList.add('hidden');
    toast.classList.remove('toast-enter');
  }, duration);
}

/** Reset entire app state and return to Step 1 */
function resetApp() {
  rawText = '';
  extractedRows = [];
  extractedFields = [];
  schemaMap = [];
  currentTableName = '';

  document.getElementById('paste-area').value = '';
  document.getElementById('file-info').classList.add('hidden');
  document.getElementById('file-input').value = '';
  document.getElementById('sql-preview-container').classList.add('hidden');
  document.getElementById('save-success-banner').classList.add('hidden');
  document.getElementById('extract-loading').classList.add('hidden');
  document.getElementById('extract-stats').classList.add('hidden');
  document.getElementById('extract-table-container').classList.add('hidden');
  document.getElementById('extract-actions').classList.add('hidden');
  document.getElementById('no-data-msg').classList.add('hidden');

  goToStep(1);
}

// ─────────────────────────────────────────────
// STEP NAVIGATION — patch for side effects
// ─────────────────────────────────────────────

// Wrap the base goToStep to run step-specific init after navigation
(function patchGoToStep() {
  const base = goToStep;
  window.goToStep = function(step) {
    base(step);
    if (step === 3) renderSchemaMap();
    if (step === 4) generateSQLPreview();
  };
})();

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  updateDbBadge();
  goToStep(1);
});
