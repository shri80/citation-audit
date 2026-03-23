// src/domAuditor.js — Puppeteer DOM audit
'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs');
require('dotenv').config();

const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT_MS) || 35000;

// ── Find Chrome/Edge on Windows ───────────────────────────────────────────────
function findChromePath() {
  if (process.platform !== 'win32') return null;

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFiles86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    // Chrome
    `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${programFiles86}\\Google\\Chrome\\Application\\chrome.exe`,
    `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
    // Edge (always present on Windows 10/11)
    `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${programFiles86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe`,
    `C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        console.log('[Browser] Found browser at:', p);
        return p;
      }
    } catch(_) {}
  }
  console.log('[Browser] No system Chrome/Edge found, will use Puppeteer bundled Chromium');
  return null;
}

// ── Browser singleton ─────────────────────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser) {
    try {
      // Check if still alive
      await _browser.version();
      return _browser;
    } catch(_) {
      _browser = null;
    }
  }

  const chromePath = findChromePath();
  const launchOpts = {
    headless:          true,
    args: [
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
    ],
    timeout: 30000,
  };

  if (chromePath) {
    launchOpts.executablePath = chromePath;
  } else if (process.platform !== 'win32') {
    launchOpts.args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }

  console.log('[Browser] Launching browser...');
  _browser = await puppeteer.launch(launchOpts);
  console.log('[Browser] Browser ready');
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch(_) {}
    _browser = null;
  }
}

// ── Field matching (mirrors extension logic) ──────────────────────────────────
const STATE_ABBR = {
  al:'alabama',ak:'alaska',az:'arizona',ar:'arkansas',ca:'california',
  co:'colorado',ct:'connecticut',de:'delaware',fl:'florida',ga:'georgia',
  hi:'hawaii',id:'idaho',il:'illinois',in:'indiana',ia:'iowa',
  ks:'kansas',ky:'kentucky',la:'louisiana',me:'maine',md:'maryland',
  ma:'massachusetts',mi:'michigan',mn:'minnesota',ms:'mississippi',
  mo:'missouri',mt:'montana',ne:'nebraska',nv:'nevada',nh:'new hampshire',
  nj:'new jersey',nm:'new mexico',ny:'new york',nc:'north carolina',
  nd:'north dakota',oh:'ohio',ok:'oklahoma',or:'oregon',pa:'pennsylvania',
  ri:'rhode island',sc:'south carolina',sd:'south dakota',tn:'tennessee',
  tx:'texas',ut:'utah',vt:'vermont',va:'virginia',wa:'washington',
  wv:'west virginia',wi:'wisconsin',wy:'wyoming',dc:'district of columbia',
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim();
}

function phoneMatch(val, body, html) {
  if (!val) return 'No';
  const digits = val.replace(/\D/g, '');
  if (digits.length < 7) return 'No';
  if (body.includes(norm(val))) return 'Yes';
  const bodyD = body.replace(/\D/g, '');
  const htmlD = html.replace(/\D/g, '');
  if (bodyD.includes(digits) || htmlD.includes(digits)) return 'Yes';
  if (digits.length >= 10 && (bodyD.includes(digits.slice(-10)) || htmlD.includes(digits.slice(-10)))) return 'Yes';
  return 'No';
}

function stateMatch(val, body, html) {
  if (!val) return 'No';
  const v = norm(val);
  const terms = [v];
  if (STATE_ABBR[v]) terms.push(STATE_ABBR[v]);
  const abbr = Object.keys(STATE_ABBR).find(a => STATE_ABBR[a] === v);
  if (abbr) terms.push(abbr);
  for (const t of terms) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}\\b`, 'i').test(body) || new RegExp(`\\b${esc}\\b`, 'i').test(html)) return 'Yes';
  }
  return 'No';
}

// ── Social Match ─────────────────────────────────────────────────────────────
// Returns Yes ONLY if the page contains the specific account from the CSV.
function socialMatch(key, val, body, html) {
  if (!val) return 'No';
  const v = norm(val);
  if (v.length < 4) return 'No';

  const DOMAINS = {
    facebook:  ['facebook.com', 'fb.com', 'fb.me', 'm.facebook.com'],
    instagram: ['instagram.com', 'instagr.am'],
    youtube:   ['youtube.com', 'youtu.be'],
  };
  const domains = DOMAINS[key] || [key + '.com'];

  // Step 1: Exact CSV URL in HTML (href, data attr, script tag, anywhere)
  if (html.includes(v) || body.includes(v)) return 'Yes';

  // Step 2: Extract handle from CSV URL
  // e.g. facebook.com/AngelsBailBonds → "angelsbailbonds"
  // e.g. youtube.com/@handle → "handle"
  // e.g. youtube.com/channel/UC1234 → "uc1234"
  let handle = '';
  try {
    const urlObj = new URL(val.trim());
    const parts  = urlObj.pathname.split('/').filter(p => p && p !== 'channel');
    if (parts.length > 0) {
      handle = parts[parts.length - 1].replace(/^@/, '').toLowerCase();
    }
  } catch(_) {
    handle = v.replace(/^@/, '');
  }
  if (!handle || handle.length < 3) return 'No';

  // Step 3: Extract all href links on the page that point to this platform
  // Use a simple scan instead of complex regex with quote issues
  const foundLinks = [];
  let searchPos = 0;
  while (searchPos < html.length) {
    const hrefIdx = html.indexOf('href=', searchPos);
    if (hrefIdx < 0) break;
    // Get the href value (handle both single and double quotes)
    const quoteChar = html[hrefIdx + 5];
    if (quoteChar !== '"' && quoteChar !== "'") { searchPos = hrefIdx + 5; continue; }
    const hrefEnd = html.indexOf(quoteChar, hrefIdx + 6);
    if (hrefEnd < 0) { searchPos = hrefIdx + 6; continue; }
    const href = html.slice(hrefIdx + 6, hrefEnd);
    // Only keep links that contain a platform domain
    if (domains.some(d => href.includes(d))) {
      foundLinks.push(href);
    }
    searchPos = hrefEnd + 1;
  }

  // Step 4: Check if any found link matches the CSV handle
  for (const link of foundLinks) {
    try {
      const linkUrl = new URL(link.startsWith('http') ? link : 'https://' + link);
      const lParts  = linkUrl.pathname.split('/').filter(p => p && p !== 'channel');
      const lHandle = lParts.length > 0
        ? lParts[lParts.length - 1].replace(/^@/, '').toLowerCase()
        : '';
      if (lHandle && handle) {
        if (lHandle === handle) return 'Yes';
        if (handle.length >= 5 && lHandle.includes(handle)) return 'Yes';
        if (lHandle.length >= 5 && handle.includes(lHandle)) return 'Yes';
      }
    } catch(_) {
      if (handle.length >= 5 && link.includes(handle)) return 'Yes';
    }
  }

  // Step 5: Handle appears within 80 chars of a platform domain in HTML
  // Only counts if they are very close — i.e. same URL string
  // (covers JSON-LD, script tags, data attributes like data-href)
  if (handle.length >= 5) {
    for (const d of domains) {
      let dPos = html.indexOf(d);
      while (dPos >= 0) {
        // Window of 80 chars — handle must be part of the same URL
        const ctx = html.slice(dPos, dPos + 80);
        if (ctx.includes(handle)) return 'Yes';
        dPos = html.indexOf(d, dPos + 1);
      }
    }
    // Step 6 removed: too loose — caused false matches on directory sites
  // (handle in meta/description + site's own FB button = false Yes)
  }

  return 'No';
}


function textMatch(key, val, body, html, title, descriptionVal) {
  if (!val) return 'No';
  const v = norm(val);
  if (v.length < 2) return 'No';
  if (key === 'state') return stateMatch(val, body, html);
  if (key === 'phone') return phoneMatch(val, body, html);

  // ── Social platform matching ──────────────────────────────────────────────
  // Rule: Return 'Yes' ONLY if the page contains a link that matches
  //       the specific account URL or handle from the CSV.
  // This means: the icon/link on the page must point to the SAME account.
  // Also: if the CSV URL itself appears anywhere in the HTML → Yes.
  if (key === 'facebook' || key === 'instagram' || key === 'youtube') {
    return socialMatch(key, val, body, html);
  }
  if (key === 'website') return websiteMatch(val, body, html);
  if (key === 'category') return categoryMatch(val, body, html, descriptionVal);
  if (key === 'country') return countryMatch(val, body, html);

  if (body.includes(v) || title.includes(v)) return 'Yes';
  const longFields = ['businessName', 'address', 'description'];
  if (longFields.includes(key) && html.includes(v)) return 'Yes';
  if (key === 'email' && (html.includes(`mailto:${v}`) || html.includes(v))) return 'Yes';
  if (v.length > 10) {
    const words = v.split(/\s+/).filter(w => w.length >= 4);
    if (words.length >= 2) {
      const hits = words.filter(w => body.includes(w) || title.includes(w));
      if (hits.length >= Math.ceil(words.length * 0.6)) return 'Yes';
    }
  }
  return 'No';
}

function categoryMatch(val, body, html, descriptionVal) {
  if (!val) return 'No';
  const v = norm(val);
  if (v.length < 2) return 'No';

  // Strip description text from body — prevents matching category from description paragraph
  let safeBody = body;
  if (descriptionVal) {
    const descNorm  = norm(descriptionVal);
    const descShort = descNorm.slice(0, 200);
    safeBody = safeBody.replace(descShort, ' ').replace(descNorm, ' ');
    const chunks = descNorm.match(/.{25,}/g) || [];
    for (const chunk of chunks) safeBody = safeBody.replace(chunk, ' ');
  }

  // Stop words — never count these as content words
  const STOP = new Set([
    'and','or','the','for','with','in','of','to','a','an','at','by',
    'from','on','is','are','was','were','be','been','has','have','had',
    'its','it','this','that','these','those','but','not','all','any',
  ]);

  // ── Check 1: Exact phrase in visible body text (most reliable) ──────────
  if (safeBody.includes(v)) return 'Yes';

  // ── Check 2: Singular/plural of exact phrase ─────────────────────────────
  const singular = v.replace(/s/g, '').trim();
  const plural   = v.replace(/(\w+)$/, '$1s');
  if (singular !== v && safeBody.includes(singular)) return 'Yes';
  if (plural   !== v && safeBody.includes(plural))   return 'Yes';

  // ── Check 3: Meta keywords / category tag only (NOT description meta) ────
  // Meta keywords are specifically set by the site owner to categorise the page
  const metaKeywords = html.match(/<meta[^>]+name=["']keywords["'][^>]*content=["']([^"']+)/gi) || [];
  const metaCategory = html.match(/<meta[^>]+name=["']category["'][^>]*content=["']([^"']+)/gi) || [];
  for (const m of [...metaKeywords, ...metaCategory]) {
    const mLow = m.toLowerCase();
    if (mLow.includes(v)) return 'Yes';
    if (singular !== v && mLow.includes(singular)) return 'Yes';
  }

  // ── Check 4: URL slug in breadcrumb/heading/canonical ONLY ─────────────
  // Avoids false match from related-topic links (e.g. TED topic nav)
  const slug  = v.replace(/\s+/g, '-');
  const slugS = singular.replace(/\s+/g, '-');
  const slugPatterns = [slug];
  if (slugS !== slug) slugPatterns.push(slugS);
  for (const s of slugPatterns) {
    if (new RegExp('breadcrumb[^>]*>[^<]*' + s, 'i').test(html)) return 'Yes';
    if (new RegExp('<h[1-3][^>]*>[^<]*' + s, 'i').test(html))    return 'Yes';
    if (new RegExp('canonical[^>]*href=[^>]*' + s, 'i').test(html)) return 'Yes';
    if (new RegExp('og.url[^>]*content=[^>]*' + s, 'i').test(html)) return 'Yes';
  }

  // ── Check 5: Structured data (JSON-LD) — very reliable ──────────────────
  // Sites often put category in schema.org JSON-LD
  const jsonLdBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const bLow = block.toLowerCase();
    if (bLow.includes(v)) return 'Yes';
    if (singular !== v && bLow.includes(singular)) return 'Yes';
  }

  // ── Check 6: Proximity match in visible body ONLY (not HTML) ────────────
  // All content words must appear within 120 chars of the first word
  // ONLY searches safeBody (visible text) — NOT the full HTML
  const contentWords = v.split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w));
  if (contentWords.length >= 2) {
    const stems = contentWords.map(w => {
      const vars = [w];
      if (w.endsWith('ing')) vars.push(w.slice(0, -3));
      if (w.endsWith('ed'))  vars.push(w.slice(0, -2));
      if (w.endsWith('er'))  vars.push(w.slice(0, -2));
      if (w.endsWith('s'))   vars.push(w.slice(0, -1));
      if (!w.endsWith('s'))  vars.push(w + 's');
      return vars;
    });

    // Check every occurrence of first word in safeBody
    let searchFrom = 0;
    for (const firstVar of stems[0]) {
      let pos = safeBody.indexOf(firstVar, searchFrom);
      while (pos >= 0) {
        const window = safeBody.slice(Math.max(0, pos - 120), pos + 120);
        const allNear = stems.slice(1).every(vars =>
          vars.some(variant => window.includes(variant))
        );
        if (allNear) return 'Yes';
        pos = safeBody.indexOf(firstVar, pos + 1);
      }
    }
  }

  return 'No';
}


function countryMatch(val, body, html) {
  if (!val) return 'No';
  const v = norm(val);
  if (v.length < 2) return 'No';

  // Direct match first
  if (body.includes(v) || html.includes(v)) return 'Yes';

  // Country abbreviation → full name map (and vice versa)
  const COUNTRY_MAP = {
    'usa':            ['united states', 'united states of america', 'u.s.a', 'u.s', 'us'],
    'us':             ['united states', 'united states of america', 'usa', 'u.s.a'],
    'u.s.a':          ['united states', 'usa', 'united states of america'],
    'u.s':            ['united states', 'usa'],
    'united states':  ['usa', 'u.s.a', 'u.s', 'us', 'united states of america'],
    'united states of america': ['usa', 'united states', 'u.s.a'],
    'uk':             ['united kingdom', 'great britain', 'england', 'britain'],
    'united kingdom': ['uk', 'great britain', 'england', 'britain'],
    'uae':            ['united arab emirates'],
    'united arab emirates': ['uae'],
    'india':          ['ind', 'bharat'],
    'canada':         ['ca', 'can'],
    'australia':      ['au', 'aus'],
    'germany':        ['de', 'deutschland'],
    'france':         ['fr'],
    'spain':          ['es', 'espana'],
    'italy':          ['it', 'italia'],
    'china':          ['cn', 'prc', "people's republic of china"],
    'japan':          ['jp', 'jpn'],
    'brazil':         ['br', 'brasil'],
    'mexico':         ['mx', 'mex'],
    'netherlands':    ['nl', 'holland', 'the netherlands'],
    'new zealand':    ['nz', 'new zealand'],
    'south africa':   ['za', 'rsa'],
    'singapore':      ['sg', 'sgp'],
    'philippines':    ['ph', 'phil'],
    'pakistan':       ['pk', 'pak'],
  };

  // Get all synonyms for the CSV value
  const synonyms = COUNTRY_MAP[v] || [];

  // Check each synonym in body and html
  for (const syn of synonyms) {
    if (body.includes(syn)) return 'Yes';
    if (html.includes(syn))  return 'Yes';
  }

  // Also check: if CSV value is an abbreviation, check for word-boundary match
  // e.g. "USA" → check for "usa" as a standalone word (not inside another word)
  if (v.length <= 5) {
    const wordBoundaryRe = new RegExp('\\b' + v.replace(/\./g, '\\.') + '\\b', 'i');
    if (wordBoundaryRe.test(body) || wordBoundaryRe.test(html)) return 'Yes';
  }

  return 'No';
}


function websiteMatch(val, body, html) {
  if (!val) return 'No';
  const v = norm(val);

  // 1. Exact match (full URL as-is)
  if (body.includes(v) || html.includes(v)) return 'Yes';

  try {
    const urlObj = new URL(val.trim());

    // 2. Strip UTM params → clean URL
    const cleanUrl = (urlObj.origin + urlObj.pathname)
      .replace(/\/$/, '').toLowerCase();
    if (body.includes(cleanUrl) || html.includes(cleanUrl)) return 'Yes';

    // 3. Domain only (no path) — e.g. angelsbailbonds.com
    const domain = urlObj.hostname.replace(/^www\./, '').toLowerCase();
    if (body.includes(domain) || html.includes(domain)) return 'Yes';

    // 4. With and without www
    const withWww    = 'www.' + domain;
    const withoutWww = domain;
    if (html.includes(withWww) || html.includes(withoutWww)) return 'Yes';

    // 5. Check href attributes specifically
    const hrefPattern = new RegExp(
      `href=["'][^"']*${domain.replace(/\./g, '\\.')}`, 'i'
    );
    if (hrefPattern.test(html)) return 'Yes';

    // 6. Path segments match — check if main path slug appears
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
      const mainSlug = pathParts[0].toLowerCase();
      if (mainSlug.length >= 4 && (body.includes(mainSlug) || html.includes(mainSlug))) return 'Yes';
    }

  } catch(_) {
    // Not a valid URL — fall back to plain text match
    if (body.includes(v) || html.includes(v)) return 'Yes';
  }

  return 'No';
}


const AUDIT_KEYS = [
  'contactName','businessName','address','city','state','zip','country',
  'phone','email','website','category','keywords','description',
  'logoUrl','facebook','instagram','youtube',
];

const BLOCK_KEYWORDS = [
  'cloudflare','verify you are human','attention required','access denied',
  'checking your browser','just a moment','ddos protection','403 forbidden',
  'forbidden','error 403',
];

// Keywords that indicate a page is not publicly accessible
// (login required, paywalled, not found, etc.)
const NOT_PUBLIC_KEYWORDS = [
  // Login / registration walls
  'login to view','sign in to view','log in to view',
  'please log in','please sign in','please login',
  'register to view','create an account to view',
  'members only','member only','subscribers only',
  'sign up to access','login required','sign in required',
  'you must be logged in','must be logged in',
  'requires login','require login','need to login',
  'need to sign in','need to register','to view this',
  'sign in or register','register or sign in',
  'sign up or log in','log in or sign up',
  'to access this','create a free account',
  // Payment / subscription walls
  'subscribe to view','subscription required','premium members',
  'upgrade to view','paid members only','premium content',
  'this is a premium','unlock this listing',
  // Not found / removed / inactive — INCLUDING findmealawyer exact phrase
  'this listing is not public or active',   // findmealawyer.com exact
  'listing is not public or active',        // findmealawyer.com variant
  'listing is not public',                  // general
  'not public or active',                   // general
  'listing is not active',                  // general
  'listing not active',
  'page not found','404 not found','this page does not exist',
  'listing not found','listing has been removed',
  'profile not found','no longer available','has been deleted',
  'page has been removed','content not found',
  'this listing is not available','listing is inactive',
  'this profile is not available','profile not available',
  'account suspended','listing suspended',
  'sorry, this listing','sorry, we couldn','sorry, this page',
  'oops! that page','oops, that page',
  // Generic error / access denied
  'access denied','permission denied','not authorized',
  'unauthorized access',
];

// ── Single page audit ─────────────────────────────────────────────────────────
async function auditPage(page, url, biz) {
  try {
    console.log('[Audit] Visiting:', url.slice(0, 60));
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await new Promise(r => setTimeout(r, 2500));

    // Check HTTP status code — non-200 responses are not public
    const httpStatus  = response?.status() || 0;
    const finalUrl    = page.url().toLowerCase();
    const originalUrl = url.toLowerCase();

    // Detect redirect to login/home page
    const redirectedToLogin = (
      finalUrl !== originalUrl &&
      /\/(login|signin|sign-in|register|signup|sign-up|auth|subscribe|membership|account)(\/|\?|$)/.test(finalUrl)
    );

    // HTTP errors → not public
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404 ||
        httpStatus === 410 || httpStatus === 451 || redirectedToLogin) {
      const reason = httpStatus ? `HTTP ${httpStatus}` : 'Redirected to login';
      console.log('[Audit] Not public:', url.slice(0, 50), '->', reason);
      const r = { _ok: true, _blocked: true, _reason: 'Not Public' };
      AUDIT_KEYS.forEach(k => { r[k] = 'N/A'; });
      return r;
    }

    const { title, body, html } = await page.evaluate(() => ({
      title: (document.title || '').toLowerCase(),
      body:  (document.body?.innerText || '').toLowerCase(),
      html:  (document.documentElement?.innerHTML || '').toLowerCase().slice(0, 500000),
    }));

    const isBlocked = BLOCK_KEYWORDS.some(k => title.includes(k) || body.includes(k));
    if (isBlocked) {
      const r = { _ok: true, _blocked: true, _reason: 'Security Block' };
      AUDIT_KEYS.forEach(k => { r[k] = 'N/A'; });
      return r;
    }

    // Detect not-public pages (login walls, paywalls, 404s, etc.)
    const isNotPublic = NOT_PUBLIC_KEYWORDS.some(k => title.includes(k) || body.includes(k));

    // Also detect if page body is too short — likely a redirect or empty page
    // A legitimate listing page should have at least 300 chars of content
    const isTooEmpty = body.trim().length < 300;

    // Also detect login/register page by URL patterns (redirect after access denied)
    const urlLower = url.toLowerCase();
    const isLoginRedirect = /\/(login|signin|sign-in|register|signup|sign-up|auth|subscribe|membership)(\/|\?|$)/.test(urlLower);

    if (isNotPublic || (isTooEmpty && !urlLower.includes('about:blank')) || isLoginRedirect) {
      const r = { _ok: true, _blocked: true, _reason: 'Not Public' };
      AUDIT_KEYS.forEach(k => { r[k] = 'N/A'; });
      return r;
    }

    // Build a version of body with the business description removed
    // so category matching cannot accidentally match from description text
    let bodyForCategory = body;
    if (biz.description) {
      const descNorm = biz.description.toLowerCase().trim();
      // Remove the description text (or first 200 chars of it) from body
      const descShort = descNorm.slice(0, 200);
      bodyForCategory = body.replace(descShort, ' ').replace(descNorm, ' ');
      // Also remove description words longer than 6 chars that are unique to it
      // by stripping any 30+ char contiguous chunk that matches
      const descWords = descNorm.split(/\s+/).filter(w => w.length > 8);
      const bigChunks = descNorm.match(/.{30,60}/g) || [];
      for (const chunk of bigChunks) {
        bodyForCategory = bodyForCategory.replace(chunk, ' ');
      }
    }

    const result = { _ok: true };
    for (const k of AUDIT_KEYS) {
      // Pass bodyForCategory for category field so it doesn't match from description
      const bodyToUse = (k === 'category') ? bodyForCategory : body;
      result[k] = textMatch(k, biz[k], bodyToUse, html, title, biz.description);
    }
    console.log('[Audit] Done:', url.slice(0, 40), '→ yes:', AUDIT_KEYS.filter(k => result[k] === 'Yes').length);
    return result;

  } catch(e) {
    console.error('[Audit] Error on', url.slice(0, 40), ':', e.message.slice(0, 80));
    const r = { _ok: false, _error: e.message.slice(0, 100) };
    AUDIT_KEYS.forEach(k => { r[k] = 'N/A'; });
    return r;
  }
}

module.exports = { auditPage, getBrowser, closeBrowser, AUDIT_KEYS };
