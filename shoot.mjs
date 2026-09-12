// Fotobot — vyfotí sledované weby konkurence a uloží je do repozitáře.
//
// Co ukládá:
//   latest/<key>.jpg               aktuální první obrazovka (přepisuje se)
//   prev/<key>.jpg                 totéž z předchozího běhu (přepisuje se)
//   full/<key>.jpg                 celá stránka, jen u cílů s "full": true
//   changed/<datum>/<key>.jpg      kopie, jen když se web OPRAVDU změnil
//   queue-shots/<datum>/<key>.jpg  jednorázové fotky z queue.txt
//   signatures.json                otisky pro srovnávání mezi běhy
//   report.json                    co se povedlo, co ne, co se změnilo
//
// Jak se pozná změna (aby „změněno" neznamenalo otočený slider):
//   1) OBRAZOVÝ otisk — fotka se zmenší na 32×20 odstínů šedi a porovná se
//      s minulou. Rozhoduje průměrná odchylka, ne bajt po bajtu.
//   2) STRUKTURNÍ otisk — H1, hlavní CTA, og:image, title a seznam CSS souborů.
//      Tohle je proti šumu nejodolnější a pozná repozicování i redesign.
//   Změna se hlásí, když překročí obrazový práh NEBO se změnila struktura.

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().slice(0, 10);
const CONCURRENCY = 4;
const NAV_TIMEOUT = 60000;
const SETTLE_MS = 5000;
const ATTEMPTS = 2;
const PIXEL_THRESHOLD = 0.07; // 0–1; pod tím je to šum (slider, jiný testimonial)

const CMP_CSS = `
#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
#onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter,
#didomi-popup, .didomi-popup-backdrop, #didomi-host,
.cc-window, .cookie-consent, .cookiebar, .cookies, #cookiescript_injected,
#cookie-law-info-bar, .cky-consent-container, .cmplz-cookiebanner,
#usercentrics-root, #cmpbox, #cmpbox2, .qc-cmp2-container, #truste-consent-track,
[id*="cookie" i][class*="banner" i], [class*="cookie" i][class*="notice" i],
[aria-label*="cookie" i][role="dialog"], [id*="consent" i][role="dialog"],
#hs-eu-cookie-confirmation, .termsfeed-com---nb, #sliding-popup,
.cookie-notice, .cookie-popup, .cookie-bar, .cookies-bar, .cookie-modal,
#cookie-consent, #cookies-consent, #cookies-modal, #cookie-bar, #cookies,
.js-cookie-consent, [class*="cookies" i][class*="modal" i], [class*="cookie" i][class*="popup" i],
[id*="consent" i][class*="modal" i], [class*="consent" i][class*="banner" i],
.drift-frame-controller, .intercom-lightweight-app, #hubspot-messages-iframe-container,
#launcher, .crisp-client, #tidio-chat, .zEWidget-launcher
{ display: none !important; visibility: hidden !important; opacity: 0 !important; }
html { scroll-behavior: auto !important; }
* { animation-play-state: paused !important; transition: none !important; }
`;

const ensureDir = (p) => fs.mkdir(p, { recursive: true });
const sha1 = (x) => createHash('sha1').update(x).digest('hex');

async function readIfExists(p) {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

async function loadJson(p, fallback) {
  const raw = await readIfExists(p);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw.toString());
  } catch {
    return fallback;
  }
}

// Obrazový otisk: 32×20 šedých pixelů jako base64.
async function pixelSignature(jpegBuf) {
  const raw = await sharp(jpegBuf).greyscale().resize(32, 20, { fit: 'fill' }).raw().toBuffer();
  return Buffer.from(raw).toString('base64');
}

function pixelDiff(aB64, bB64) {
  if (!aB64 || !bB64) return null;
  const a = Buffer.from(aB64, 'base64');
  const b = Buffer.from(bB64, 'base64');
  if (a.length !== b.length || a.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}

async function loadQueue() {
  const raw = await readIfExists(path.join(ROOT, 'queue.txt'));
  if (!raw) return [];
  return raw
    .toString()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [key, url] = l.split('|').map((s) => (s || '').trim());
      return url ? { key: key.replace(/[^a-z0-9._-]/gi, '-').toLowerCase(), url } : null;
    })
    .filter(Boolean);
}

async function shoot(browser, target, { isQueue = false, isDeep = false } = {}) {
  const result = { key: target.key, url: target.url, ok: false };
  const failedResources = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  page.on('requestfailed', (req) => {
    const t = req.resourceType();
    if (t === 'stylesheet' || t === 'script' || t === 'image' || t === 'font') {
      failedResources.push(`${t}:${req.url().slice(0, 120)}`);
    }
  });
  page.on('response', (res) => {
    const t = res.request().resourceType();
    if ((t === 'stylesheet' || t === 'script') && res.status() >= 400) {
      failedResources.push(`${t}:${res.status()}:${res.url().slice(0, 120)}`);
    }
  });

  try {
    const resp = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    result.status = resp ? resp.status() : null;
    result.finalUrl = page.url();
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.addStyleTag({ content: CMP_CSS }).catch(() => {});
    await page.waitForTimeout(target.settle || SETTLE_MS);
    await page
      .evaluate(async () => {
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight && y < step * 12; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 180));
        }
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 600));
      })
      .catch(() => {});

    // Zdravotní kontrola: nastylovala se stránka vůbec?
    const health = await page
      .evaluate(() => {
        let ruleCount = 0;
        for (const s of Array.from(document.styleSheets)) {
          try {
            ruleCount += s.cssRules ? s.cssRules.length : 0;
          } catch {
            ruleCount += 1; // cross-origin, pravidla nejdou přečíst, ale sheet existuje
          }
        }
        const imgs = Array.from(document.images);
        const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).length;
        const h1 = document.querySelector('h1');
        const cta =
          document.querySelector('a[class*="btn" i], button, a[class*="button" i], [role="button"]');
        const og = document.querySelector('meta[property="og:image"]');
        const sheets = Array.from(document.styleSheets)
          .map((s) => (s.href || '').split('?')[0])
          .filter(Boolean)
          .sort();
        return {
          ruleCount,
          imgTotal: imgs.length,
          imgBroken: broken,
          bodyHeight: document.body ? document.body.scrollHeight : 0,
          h1: h1 ? h1.innerText.trim().slice(0, 200) : '',
          cta: cta ? (cta.innerText || '').trim().slice(0, 80) : '',
          og: og ? og.content : '',
          title: document.title.slice(0, 200),
          sheets,
        };
      })
      .catch(() => null);

    if (health) {
      result.health = {
        ruleCount: health.ruleCount,
        imgBroken: health.imgBroken,
        imgTotal: health.imgTotal,
        bodyHeight: health.bodyHeight,
        failedResources: failedResources.length,
      };
      result.title = health.title;
      // Strukturní otisk — proti šumu nejodolnější signál změny.
      result.struct = sha1(
        [health.h1, health.cta, health.og, health.title, health.sheets.join('|')].join('')
      );
      result.h1 = health.h1;

      // Poznámka: počet CSS pravidel se NEHLÍDÁ — u externích stylů je nelze
      // přečíst a každý normální web pak vypadá jako rozbitý (ověřeno 12.9.
      // na Leadhubu a Sendlane, oba byly v pořádku).
      const cssFailed = failedResources.some((f) => f.startsWith('stylesheet'));
      const brokenRatio = health.imgTotal > 5 ? health.imgBroken / health.imgTotal : 0;
      const shortPage = health.bodyHeight < 700;
      result.suspicious = shortPage || brokenRatio > 0.6 || (cssFailed && brokenRatio > 0.3);
      if (result.suspicious) {
        result.suspiciousWhy = [
          shortPage ? `nizka stranka (${health.bodyHeight}px)` : null,
          brokenRatio > 0.3 ? `rozbite obrazky (${health.imgBroken}/${health.imgTotal})` : null,
          cssFailed ? 'nenacetl se stylesheet' : null,
        ]
          .filter(Boolean)
          .join(', ');
      }
    } else {
      result.suspicious = true;
      result.suspiciousWhy = 'stranku nejde precist';
    }

    const shotBuf = await page.screenshot({ type: 'jpeg', quality: 72 });
    result.pix = await pixelSignature(shotBuf).catch(() => null);

    if (isDeep) {
      const dir = path.join(ROOT, 'deep', TODAY);
      await ensureDir(dir);
      await fs.writeFile(path.join(dir, `${target.key}.jpg`), shotBuf);
      result.path = `deep/${TODAY}/${target.key}.jpg`;
      result.own = Boolean(target.own);
      result.ok = true;
      return result;
    }

    if (isQueue) {
      const dir = path.join(ROOT, 'queue-shots', TODAY);
      await ensureDir(dir);
      await fs.writeFile(path.join(dir, `${target.key}.jpg`), shotBuf);
      result.path = `queue-shots/${TODAY}/${target.key}.jpg`;
      result.ok = true;
      return result;
    }

    const latestPath = path.join(ROOT, 'latest', `${target.key}.jpg`);
    const prevPath = path.join(ROOT, 'prev', `${target.key}.jpg`);
    await ensureDir(path.dirname(latestPath));
    await ensureDir(path.dirname(prevPath));

    const old = await readIfExists(latestPath);
    if (old) await fs.writeFile(prevPath, old);
    await fs.writeFile(latestPath, shotBuf);
    result.path = `latest/${target.key}.jpg`;
    result.shotBuf = shotBuf; // jen v paměti, pro případné uložení do changed/

    if (target.full) {
      const fullBuf = await page.screenshot({ type: 'jpeg', quality: 68, fullPage: true });
      await ensureDir(path.join(ROOT, 'full'));
      await fs.writeFile(path.join(ROOT, 'full', `${target.key}.jpg`), fullBuf);
      result.fullPath = `full/${target.key}.jpg`;
    }

    result.ok = true;
    return result;
  } catch (err) {
    result.error = String(err && err.message ? err.message : err).slice(0, 300);
    return result;
  } finally {
    await ctx.close().catch(() => {});
  }
}

const pool2 = (...a) => pool(...a);

async function pool(items, worker, size) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx]);
      }
    })
  );
  return out;
}


// ── Denní téma a hledání podstránek ────────────────────────────────────────
// Fotograf si seznam podstránek odvodí sám: vezme dnešní téma, rotující partii
// konkurentů, a u každého najde v jeho vlastní sitemapě adresy, které tématu
// odpovídají. Nikdo mu nic nediktuje.

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'fotobot (interni prehled konkurence)' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/xml|text|html/i.test(ct)) return null;
    return (await res.text()).slice(0, 3_000_000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function urlsFromSitemapXml(xml) {
  return Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
}

async function sitemapUrls(origin) {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const robots = await fetchText(`${origin}/robots.txt`, 8000);
  if (robots) {
    for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) candidates.push(m[1]);
  }
  const seen = new Set();
  const out = [];
  for (const c of candidates.slice(0, 5)) {
    const xml = await fetchText(c);
    if (!xml) continue;
    const found = urlsFromSitemapXml(xml);
    // Vnořený sitemap index — jdeme o úroveň hlouběji, max 3 dílčí mapy.
    const nested = found.filter((u) => /\.xml(\?|$)/i.test(u)).slice(0, 3);
    for (const n of nested) {
      const sub = await fetchText(n);
      if (sub) for (const u of urlsFromSitemapXml(sub)) if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
    for (const u of found) if (!/\.xml(\?|$)/i.test(u) && !seen.has(u)) { seen.add(u); out.push(u); }
    if (out.length > 50) break;
  }
  return out;
}

// Když sitemapa není, posbíráme odkazy z navigace homepage.
async function navUrls(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'cs-CZ' });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.href)
        .filter((h) => h.startsWith(location.origin))
        .slice(0, 400)
    );
  } catch {
    return [];
  } finally {
    await ctx.close().catch(() => {});
  }
}

function pickByKeywords(urls, keywords, limit) {
  const scored = [];
  for (const u of urls) {
    let pathPart;
    try {
      pathPart = decodeURIComponent(new URL(u).pathname.toLowerCase());
    } catch {
      continue;
    }
    if (pathPart === '/' || pathPart.length > 90) continue;
    if (/\/(blog|news|clanky|post|category|tag|author|help|docs|support|napoveda)\//.test(pathPart)) continue;
    const hit = keywords.findIndex((k) => pathPart.includes(k));
    if (hit === -1) continue;
    // Kratší cesta = obvykle hlavní stránka tématu, ne odbočka.
    scored.push({ url: u, score: hit * 100 + pathPart.split('/').filter(Boolean).length * 10 + pathPart.length / 100 });
  }
  scored.sort((a, b) => a.score - b.score);
  const out = [];
  const seenPaths = new Set();
  for (const s of scored) {
    const key = new URL(s.url).pathname.replace(/\/$/, '');
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    out.push(s.url);
    if (out.length >= limit) break;
  }
  return out;
}

const targetsRaw = JSON.parse(await fs.readFile(path.join(ROOT, 'targets.json'), 'utf8'));
// Cíl může mít adresu schovanou v tajném nastavení repozitáře (urlEnv) —
// aby v repu nebylo vidět, čí weby to jsou.
const targets = targetsRaw
  .map((t) => (t.urlEnv ? { ...t, url: process.env[t.urlEnv] || '' } : t))
  .filter((t) => {
    if (!t.url) {
      console.log(`preskakuji ${t.key}: chybi promenna ${t.urlEnv || '(url)'}`);
      return false;
    }
    return true;
  });
const queue = await loadQueue();
const signatures = await loadJson(path.join(ROOT, 'signatures.json'), {});

const browser = await chromium.launch({
  args: ['--disable-dev-shm-usage'],
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});

async function shootWithRetry(target, opts = {}) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await shoot(browser, target, opts);
    last.attempts = attempt;
    if (last.ok) return last; // podezření neopakujeme, jen skutečnou chybu
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

const results = await pool(targets, (t) => shootWithRetry(t), CONCURRENCY);
const queueResults = queue.length
  ? await pool(queue, (t) => shootWithRetry(t, { isQueue: true }), CONCURRENCY)
  : [];


// ── Hloubková fáze: dnešní téma ────────────────────────────────────────────
const pageTypes = await loadJson(path.join(ROOT, 'page-types.json'), null);
let deepResults = [];
let todaysTheme = null;

if (pageTypes && Array.isArray(pageTypes.types) && pageTypes.types.length) {
  const dayIndex = Math.floor(Date.now() / 86400000);
  const theme = pageTypes.types[dayIndex % pageTypes.types.length];
  todaysTheme = theme.type;
  const perDay = pageTypes.perDay || 12;
  const pagesPerSite = pageTypes.pagesPerSite || 2;

  // Rotující partie konkurentů (naše weby sem nepatří, ty máme v theme.us).
  const pool = targets.filter((t) => !t.own);
  const start = (dayIndex * perDay) % pool.length;
  const slice = Array.from({ length: Math.min(perDay, pool.length) }, (_, i) => pool[(start + i) % pool.length]);

  const deepTargets = [];
  for (const t of slice) {
    let origin;
    try {
      origin = new URL(t.url).origin;
    } catch {
      continue;
    }
    let urls = await sitemapUrls(origin);
    if (urls.length < 5) urls = await navUrls(browser, t.url);
    const picked = pickByKeywords(urls, theme.keywords, pagesPerSite);
    picked.forEach((u, i) => deepTargets.push({ key: `${t.key}--${theme.type}${i ? '-' + (i + 1) : ''}`, url: u }));
  }

  // A náš web ke stejnému tématu — proto se fotí jen když je k čemu srovnávat.
  const ourUrlsForTheme = [
    ...(theme.us || []),
    ...((theme.usEnv || []).map((name) => process.env[name]).filter(Boolean)),
  ];
  ourUrlsForTheme.forEach((u, i) =>
    deepTargets.push({ key: `nase--${theme.type}${i ? '-' + (i + 1) : ''}`, url: u, own: true })
  );

  deepResults = deepTargets.length
    ? await pool2(deepTargets, (t) => shoot(browser, t, { isDeep: true }), CONCURRENCY)
    : [];
}


// ── Náš web: hlídání nových stránek (EMA, srovnávačky Ecomail vs. X) ───────
// Běží každý běh. V naší sitemapě hledá stránky odpovídající vzorům z
// page-types.json → ownWatch a fotí jen ty, které jsme ještě nikdy nefotili.
let ownWatchResults = [];
const ownSitemap =
  pageTypes && pageTypes.ownWatch
    ? pageTypes.ownWatch.sitemap || process.env[pageTypes.ownWatch.sitemapEnv || ''] || ''
    : '';
if (ownSitemap) {
  const ow = { ...pageTypes.ownWatch, sitemap: ownSitemap };
  const seenKey = '__ownSeen';
  const seen = new Set((signatures[seenKey] && signatures[seenKey].urls) || []);
  const xml = await fetchText(ow.sitemap);
  let ourUrls = xml ? urlsFromSitemapXml(xml) : [];
  if (!ourUrls.length) {
    const origin = new URL(ow.sitemap).origin;
    ourUrls = await sitemapUrls(origin);
  }
  const pats = (ow.patterns || []).map((x) => x.toLowerCase());
  const fresh = ourUrls
    .filter((u) => {
      let pathPart;
      try {
        pathPart = decodeURIComponent(new URL(u).pathname.toLowerCase());
      } catch {
        return false;
      }
      if (/\/(blog|slovnik-pojmu|webinare|napoveda)\//.test(pathPart)) return false;
      return pats.some((k) => pathPart.includes(k)) && !seen.has(u);
    })
    .slice(0, ow.maxPerRun || 3);

  if (fresh.length) {
    const owTargets = fresh.map((u) => {
      const slug = new URL(u).pathname.replace(/\//g, '-').replace(/^-|-$/g, '') || 'home';
      return { key: `nase--novinka--${slug}`.slice(0, 90), url: u, own: true };
    });
    ownWatchResults = await pool2(owTargets, (t) => shoot(browser, t, { isDeep: true }), CONCURRENCY);
    for (const u of fresh) seen.add(u);
  }
  // Poprvé si celý seznam jen zapamatujeme, ať to nezaplaví první běh.
  if (!signatures[seenKey]) for (const u of ourUrls) seen.add(u);
  signatures[seenKey] = { urls: Array.from(seen).slice(-400), ts: new Date().toISOString() };
}

await browser.close();

// Vyhodnocení změn proti uloženým otiskům
for (const r of results) {
  if (!r.ok) continue;
  const prevSig = signatures[r.key];
  r.pixelDiff = prevSig ? pixelDiff(prevSig.pix, r.pix) : null;
  r.structChanged = prevSig ? Boolean(prevSig.struct && r.struct && prevSig.struct !== r.struct) : false;
  r.changed =
    Boolean(prevSig) &&
    !r.suspicious &&
    ((r.pixelDiff !== null && r.pixelDiff > PIXEL_THRESHOLD) || r.structChanged);
  r.changeReason = r.changed
    ? [
        r.pixelDiff !== null && r.pixelDiff > PIXEL_THRESHOLD
          ? `obraz ${(r.pixelDiff * 100).toFixed(1)} %`
          : null,
        r.structChanged ? 'struktura (H1/CTA/og:image/CSS)' : null,
      ]
        .filter(Boolean)
        .join(' + ')
    : null;

  if (r.changed && r.shotBuf) {
    const dir = path.join(ROOT, 'changed', TODAY);
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, `${r.key}.jpg`), r.shotBuf);
    r.changedPath = `changed/${TODAY}/${r.key}.jpg`;
  }

  signatures[r.key] = {
    pix: r.pix,
    struct: r.struct,
    h1: r.h1,
    ts: new Date().toISOString(),
  };
  delete r.shotBuf;
  delete r.pix;
}
for (const q of queueResults) {
  delete q.shotBuf;
  delete q.pix;
}

await fs.writeFile(path.join(ROOT, 'signatures.json'), JSON.stringify(signatures, null, 2));

for (const d of [...deepResults, ...ownWatchResults]) { delete d.shotBuf; delete d.pix; }

const report = {
  runAt: new Date().toISOString(),
  date: TODAY,
  pixelThreshold: PIXEL_THRESHOLD,
  tema: todaysTheme,
  counts: {
    targets: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    suspicious: results.filter((r) => r.ok && r.suspicious).length,
    changed: results.filter((r) => r.changed).length,
    queue: queueResults.length,
    deep: deepResults.filter((d) => d.ok).length,
    naseNovinky: ownWatchResults.filter((d) => d.ok).length,
  },
  naseNovinky: ownWatchResults.map((d) => ({ key: d.key, url: d.url, shot: d.path, h1: d.h1, ok: d.ok })),
  deep: deepResults.map((d) => ({ key: d.key, url: d.url, shot: d.path, own: d.own, h1: d.h1, ok: d.ok })),
  changed: results
    .filter((r) => r.changed)
    .map((r) => ({ key: r.key, url: r.url, why: r.changeReason, shot: r.changedPath, h1: r.h1 })),
  suspicious: results
    .filter((r) => r.ok && r.suspicious)
    .map((r) => ({ key: r.key, url: r.url, why: r.suspiciousWhy })),
  failed: results
    .filter((r) => !r.ok)
    .map((r) => ({ key: r.key, url: r.url, status: r.status, error: r.error })),
  targets: results,
  queue: queueResults,
};

await fs.writeFile(path.join(ROOT, 'report.json'), JSON.stringify(report, null, 2));

console.log('tema dne:', todaysTheme, JSON.stringify(report.counts));
if (report.failed.length) console.log('SPADLO:', report.failed.map((f) => f.key).join(', '));
if (report.suspicious.length)
  console.log('PODEZRELE:', report.suspicious.map((s) => `${s.key} (${s.why})`).join(', '));
if (report.naseNovinky.length)
  console.log('NASE NOVE STRANKY:', report.naseNovinky.map((n) => n.url).join(', '));
if (report.changed.length)
  console.log('ZMENENO:', report.changed.map((c) => `${c.key} [${c.why}]`).join(', '));
