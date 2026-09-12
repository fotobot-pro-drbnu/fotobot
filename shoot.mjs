// Fotobot — vyfotí sledované weby konkurence a uloží je do repozitáře.
//
// Co dělá:
//   latest/<key>.jpg        aktuální fotka první obrazovky (přepisuje se)
//   prev/<key>.jpg          fotka z předchozího běhu (přepisuje se)
//   full/<key>.jpg          celá stránka, jen u cílů s "full": true
//   changed/<datum>/<key>.jpg   kopie, ale POUZE když se fotka od minule změnila
//   queue-shots/<datum>/<key>.jpg  jednorázové fotky z queue.txt
//   report.json             co se povedlo, co ne, co se změnilo
//
// Repozitář neroste do nekonečna: latest/prev/full se přepisují,
// přibývá jen to, co se reálně změnilo.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().slice(0, 10);
const CONCURRENCY = 4;
const NAV_TIMEOUT = 60000;
const SETTLE_MS = 5000; // čas na dojetí animací a lazy loadu
const ATTEMPTS = 2;    // pomalé weby dostanou druhou šanci

// Nejčastější cookie lišty — schováme je CSS, je to spolehlivější než klikat.
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
`;

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readIfExists(p) {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
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

async function shoot(browser, target, { isQueue = false } = {}) {
  const result = { key: target.key, url: target.url, ok: false };
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    result.status = resp ? resp.status() : null;
    result.finalUrl = page.url();
    // Některé weby dokreslují layout až po 'load'; počkáme, ale nepadáme na tom.
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.addStyleTag({ content: CMP_CSS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    // Necháme dojet lazy load: projedeme stránku dolů a zpátky nahoru.
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
    result.title = await page.title().catch(() => null);

    // Kontrola, že stránka není nenastylovaná ruina (chybí CSS = rozbitá fotka).
    const styleCheck = await page
      .evaluate(() => ({
        sheets: document.styleSheets.length,
        height: document.body ? document.body.scrollHeight : 0,
      }))
      .catch(() => ({ sheets: 0, height: 0 }));
    result.styleSheets = styleCheck.sheets;
    result.pageHeight = styleCheck.height;
    if (styleCheck.sheets === 0) {
      // Dej tomu ještě čas, může to být pomalý JS renderer.
      await page.waitForTimeout(4000);
      result.styleSheets = await page.evaluate(() => document.styleSheets.length).catch(() => 0);
    }
    result.suspicious = result.styleSheets === 0 || result.pageHeight < 700;

    const shotBuf = await page.screenshot({ type: 'jpeg', quality: 72 });
    result.hash = sha1(shotBuf);

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
    if (old) {
      result.prevHash = sha1(old);
      await fs.writeFile(prevPath, old);
    }
    await fs.writeFile(latestPath, shotBuf);
    result.path = `latest/${target.key}.jpg`;

    // Změna = jiná fotka než minule. Uložíme kopii do changed/, to je náš radar.
    result.changed = Boolean(old) && result.prevHash !== result.hash;
    if (result.changed) {
      const dir = path.join(ROOT, 'changed', TODAY);
      await ensureDir(dir);
      await fs.writeFile(path.join(dir, `${target.key}.jpg`), shotBuf);
      result.changedPath = `changed/${TODAY}/${target.key}.jpg`;
    }

    if (target.full) {
      const fullBuf = await page.screenshot({ type: 'jpeg', quality: 68, fullPage: true });
      const fullPath = path.join(ROOT, 'full', `${target.key}.jpg`);
      await ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, fullBuf);
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

async function pool(items, worker, size) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return out;
}

const targets = JSON.parse(await fs.readFile(path.join(ROOT, 'targets.json'), 'utf8'));
const queue = await loadQueue();

// PLAYWRIGHT_EXECUTABLE_PATH je jen pro lokální testování; na GitHubu se
// Chromium instaluje standardně a proměnná se nenastavuje.
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
    if (last.ok && !last.suspicious) return last;
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 2500));
  }
  return last;
}

const results = await pool(targets, (t) => shootWithRetry(t), CONCURRENCY);
const queueResults = queue.length
  ? await pool(queue, (t) => shootWithRetry(t, { isQueue: true }), CONCURRENCY)
  : [];

await browser.close();

const report = {
  runAt: new Date().toISOString(),
  date: TODAY,
  counts: {
    targets: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    changed: results.filter((r) => r.changed).length,
    suspicious: results.filter((r) => r.ok && r.suspicious).length,
    queue: queueResults.length,
  },
  changed: results.filter((r) => r.changed).map((r) => ({ key: r.key, url: r.url, shot: r.changedPath })),
  failed: results.filter((r) => !r.ok).map((r) => ({ key: r.key, url: r.url, error: r.error, status: r.status })),
  suspicious: results
    .filter((r) => r.ok && r.suspicious)
    .map((r) => ({ key: r.key, url: r.url, styleSheets: r.styleSheets, pageHeight: r.pageHeight })),
  targets: results,
  queue: queueResults,
};

await fs.writeFile(path.join(ROOT, 'report.json'), JSON.stringify(report, null, 2));

// Frontu po vyfocení vyprázdníme, ať se nefotí pořád to samé.
if (queue.length) {
  const done = queueResults.map((r) => `${r.runAt || TODAY} ${r.key}|${r.url} -> ${r.path || r.error}`).join('\n');
  await fs.appendFile(path.join(ROOT, 'queue-done.txt'), `\n# ${TODAY}\n${done}\n`);
  await fs.writeFile(path.join(ROOT, 'queue.txt'), '# Sem přidávej řádky ve formátu:  klic|https://adresa\n');
}

console.log(JSON.stringify(report.counts));
if (report.failed.length) console.log('FAILED:', report.failed.map((f) => f.key).join(', '));
if (report.changed.length) console.log('CHANGED:', report.changed.map((c) => c.key).join(', '));
if (report.suspicious.length) console.log('PODEZRELE (mozna rozbita fotka):', report.suspicious.map((s) => s.key).join(', '));
