// src/screenshotOcr.js — Server-side Tesseract OCR for pending sites
'use strict';

const https  = require('https');
const http   = require('http');
const { URL } = require('url');

const AUDIT_KEYS = [
  'contactName','businessName','address','city','state','zip','country',
  'phone','email','website','category','keywords','description',
  'logoUrl','facebook','instagram','youtube',
];

// ── Convert Drive share URL → thumbnail ──────────────────────────────────────
function toDriveDirectUrl(s) {
  if (!s) return s;
  const m = s.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1600`;
  return s;
}

// ── Fetch image as Buffer (follows redirects) ─────────────────────────────────
function fetchImage(rawUrl) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    function doFetch(u) {
      let parsed;
      try { parsed = new URL(u); } catch(e) { return reject(new Error('Invalid URL: ' + u)); }

      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept':     'image/jpeg,image/png,image/webp,image/*,*/*',
        },
        timeout: 25000,
      }, res => {
        // Follow redirects
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          if (++redirects > 8) return reject(new Error('Too many redirects'));
          let next = res.headers.location;
          if (!next.startsWith('http')) next = `${parsed.protocol}//${parsed.host}${next}`;
          res.resume();
          return doFetch(next);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${u.slice(0,60)}`));
        }

        const contentType = res.headers['content-type'] || '';
        // Reject HTML responses (virus scan warning page, login page etc)
        if (contentType.includes('text/html')) {
          res.resume();
          return reject(new Error('Got HTML instead of image — Drive file may need to be shared publicly'));
        }

        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length < 1000) {
            return reject(new Error(`Image too small (${buffer.length} bytes) — may be an error page`));
          }
          resolve({ buffer, contentType });
        });
        res.on('error', reject);
      });
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Fetch timeout')); });
    }
    doFetch(rawUrl);
  });
}

// ── Field match helpers ────────────────────────────────────────────────────────
function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim();
}

function fieldMatch(key, val, extractedText) {
  if (!val) return 'No';
  const v = norm(val);
  if (v.length < 2) return 'No';
  if (extractedText.includes(v)) return 'Yes';

  // ── Social platform matching ──────────────────────────────────────────
  if (key === 'facebook' || key === 'instagram' || key === 'youtube') {
    // OCR text: check exact URL or handle from CSV appears in extracted text
    if (extractedText.includes(v)) return 'Yes';

    // Extract handle from CSV URL
    let handle = '';
    try {
      const urlObj = new URL(val.trim());
      const parts  = urlObj.pathname.split('/').filter(p => p && p !== 'channel');
      if (parts.length > 0) handle = parts[parts.length - 1].replace(/^@/, '').toLowerCase();
    } catch(_) { handle = v.replace(/^@/, ''); }

    const DOMAINS = {
      facebook:  ['facebook.com', 'fb.com'],
      instagram: ['instagram.com'],
      youtube:   ['youtube.com', 'youtu.be'],
    };
    const domains = DOMAINS[key] || [key + '.com'];

    // Check domain in OCR text
    if (domains.some(d => extractedText.includes(d))) {
      // Also check handle nearby
      if (handle.length >= 4 && extractedText.includes(handle)) return 'Yes';
      // Domain found — likely a social icon printed with URL
      return 'Yes';
    }

    // Handle in text (for cases where only handle is printed)
    if (handle.length >= 5 && extractedText.includes(handle)) return 'Yes';

    return 'No';
  }
  if (key === 'country') {
    if (extractedText.includes(v)) return 'Yes';
    const COUNTRY_MAP = {
      'usa':           ['united states', 'united states of america', 'u.s.a', 'u.s'],
      'us':            ['united states', 'united states of america', 'usa'],
      'united states': ['usa', 'u.s.a', 'u.s', 'united states of america'],
      'united states of america': ['usa', 'united states'],
      'uk':            ['united kingdom', 'great britain', 'england'],
      'united kingdom':['uk', 'great britain', 'england'],
      'uae':           ['united arab emirates'],
      'india':         ['bharat'],
      'canada':        ['ca', 'can'],
      'australia':     ['au', 'aus'],
    };
    const synonyms = COUNTRY_MAP[v] || [];
    for (const syn of synonyms) {
      if (extractedText.includes(syn)) return 'Yes';
    }
    return 'No';
  }

  if (key === 'phone') {
    const digits     = val.replace(/\D/g, '');
    const textDigits = extractedText.replace(/\D/g, '');
    if (digits.length >= 7  && textDigits.includes(digits))            return 'Yes';
    if (digits.length >= 10 && textDigits.includes(digits.slice(-10))) return 'Yes';
    return 'No';
  }
  if (v.length > 10) {
    const words = v.split(/\s+/).filter(w => w.length >= 4);
    if (words.length >= 2) {
      const hits = words.filter(w => extractedText.includes(w));
      if (hits.length >= Math.ceil(words.length * 0.6)) return 'Yes';
    }
  }
  return 'No';
}

// ── Main OCR function ─────────────────────────────────────────────────────────
async function auditViaScreenshot(screenshotUrl, biz) {
  console.log('[OCR] Starting for:', screenshotUrl ? screenshotUrl.slice(0, 70) : 'NO URL');

  // Guard
  if (!screenshotUrl || !/^https?:\/\/.+/.test(screenshotUrl.trim())) {
    const r = {}; AUDIT_KEYS.forEach(k => { r[k] = 'No'; });
    r._ocr = true; r._ocrError = 'No valid screenshot URL';
    return r;
  }

  // Convert Drive URL
  const fetchUrl = toDriveDirectUrl(screenshotUrl.trim());
  console.log('[OCR] Fetching image from:', fetchUrl.slice(0, 80));

  // Fetch image buffer
  let imageBuffer;
  try {
    const { buffer, contentType } = await fetchImage(fetchUrl);
    imageBuffer = buffer;
    console.log(`[OCR] Image fetched: ${buffer.length} bytes, type: ${contentType}`);
  } catch(e) {
    console.error('[OCR] Image fetch failed:', e.message);
    const r = {}; AUDIT_KEYS.forEach(k => { r[k] = 'No'; });
    r._ocr = true; r._ocrError = 'Fetch failed: ' + e.message.slice(0, 100);
    return r;
  }

  // Run Tesseract — wrapped in a separate async block with full error isolation
  let extractedText = '';
  try {
    // Lazy-require Tesseract so a crash here doesn't take down the server
    const Tesseract = require('tesseract.js');
    console.log('[OCR] Running Tesseract on buffer...');

    const result = await new Promise(async (resolve, reject) => {
      // Timeout: if Tesseract hangs, reject after 60s
      const timer = setTimeout(() => reject(new Error('Tesseract timeout after 60s')), 60000);
      try {
        const worker = await Tesseract.createWorker('eng');
        const { data } = await worker.recognize(imageBuffer);
        await worker.terminate();
        clearTimeout(timer);
        resolve(data.text || '');
      } catch(e) {
        clearTimeout(timer);
        reject(e);
      }
    });

    extractedText = result.toLowerCase().trim();
    console.log(`[OCR] Extracted ${extractedText.length} chars. Preview: ${extractedText.slice(0, 100)}`);

  } catch(e) {
    console.error('[OCR] Tesseract error (non-fatal):', e.message);
    const r = {}; AUDIT_KEYS.forEach(k => { r[k] = 'No'; });
    r._ocr = true; r._ocrError = 'OCR failed: ' + e.message.slice(0, 100);
    return r;
  }

  // Match fields
  const result = { _ok: true, _ocr: true, _ocrSource: 'tesseract-server' };
  for (const k of AUDIT_KEYS) {
    result[k] = fieldMatch(k, biz[k], extractedText);
  }
  console.log('[OCR] Result:', JSON.stringify(result));
  return result;
}

module.exports = { auditViaScreenshot, AUDIT_KEYS };
