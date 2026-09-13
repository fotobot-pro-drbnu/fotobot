// extras.mjs — rozšíření fotobota o tři věci, které shoot.mjs nedělá:
//
//   A) FEEDY    — co za posledních 48 h vyšlo na blozích konkurence, v českém
//                 marketingovém tisku a v designových médiích  →  feeds.json
//   B) CENÍKY   — kolik si kdo účtuje, vyfocené i vytažené jako čísla, a co se
//                 od minule změnilo                            →  prices.json
//   C) E-MAILY  — skutečné newslettery konkurence vyfocené ze
//                 vzorníků a veřejných archivů                 →  emails.json
//
// Běží až PO shoot.mjs a je na něm nezávislý — když spadne, fotky z hlavního
// běhu to neohrozí. Vždycky zapíše všechny tři soubory, i kdyby byly prázdné.
//
// Spuštění:  node extras.mjs

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().slice(0, 10);
const DOY = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const NAV_TIMEOUT = 30000;
const SETTLE_MS = 3500;

const log = (...a) => console.log(...a);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, file), 'utf8')); }
  catch { return fallback; }
}
async function writeJson(file, data) {
  await fs.writeFile(path.join(ROOT, file), JSON.stringify(data, null, 2) + '\n');
}
async function ensureDir(dir) {
  await fs.mkdir(path.join(ROOT, dir), { recursive: true });
}
// Vezme z rotujícího seznamu dnešní partii.
function slice(list, perDay, salt = 0) {
  if (!perDay || perDay >= list.length) return list;
  const start = ((DOY + salt) * perDay) % list.length;
  const out = [];
  for (let i = 0; i < perDay; i++) out.push(list[(start + i) % list.length]);
  return out;
}
const strip = (s) => (s || '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#3[49];/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// ───────────────────────────────────────────────────────────── A) FEEDY ────

const FEED_PATHS = ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml',
  '/index.xml', '/blog/feed', '/blog/feed/', '/blog/rss.xml', '/blog/index.xml',
  '/news/feed/', '/en/feed/'];

function looksLikeFeed(body) {
  if (!body || body.length < 120) return false;
  const head = body.slice(0, 3000).toLowerCase();
  return (head.includes('<rss') || head.includes('<feed') || head.includes('<rdf'))
    && (body.includes('<item') || body.includes('<entry'));
}

function parseFeed(xml, limit = 12) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const out = [];
  for (const b of blocks.slice(0, limit)) {
    const title = strip((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = strip((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    if (!link) link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || '';
    const dateRaw = strip(
      (b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] ||
      (b.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] ||
      (b.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] ||
      (b.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) || [])[1] || ''
    );
    const ts = dateRaw ? Date.parse(dateRaw) : NaN;
    if (title) out.push({ title, url: link, date: dateRaw, ts: Number.isNaN(ts) ? null : ts });
  }
  return out;
}

async function grab(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function runFeeds() {
  // POZOR: konfigurace je feeds-config.json, výstup je feeds.json. Nesmí se to
  // plést dohromady, jinak si běh přepíše vlastní seznam zdrojů.
  const cfg = await readJson('feeds-config.json', null);
  if (!cfg || !cfg.groups) { log('feeds: chybí konfigurace feeds-config.json'); return; }
  const state = await readJson('feeds-state.json', {});
  const maxAge = (cfg.maxAgeHours || 48) * 3600000;
  const now = Date.now();
  const result = { generatedAt: new Date().toISOString(), maxAgeHours: cfg.maxAgeHours || 48, groups: {}, discovered: {}, failed: [] };

  for (const [gk, group] of Object.entries(cfg.groups)) {
    const items = [];
    for (const src of group.sources) {
      let feedUrl = src.feed || state[src.key]?.feed || null;
      let xml = feedUrl ? await grab(feedUrl) : null;

      if (!looksLikeFeed(xml) && src.site) {          // hledání adresy feedu
        feedUrl = null; xml = null;
        for (const p of FEED_PATHS) {
          const cand = src.site.replace(/\/$/, '') + p;
          const body = await grab(cand);
          if (looksLikeFeed(body)) { feedUrl = cand; xml = body; break; }
        }
        if (feedUrl) { result.discovered[src.key] = feedUrl; log(`feeds: ${src.key} → ${feedUrl}`); }
      }
      if (!looksLikeFeed(xml)) { result.failed.push({ key: src.key, name: src.name, reason: 'feed nenalezen' }); continue; }

      state[src.key] = { feed: feedUrl, ok: new Date().toISOString() };
      for (const it of parseFeed(xml)) {
        if (it.ts && now - it.ts > maxAge) continue;   // starší než okno → pryč
        items.push({ source: src.key, name: src.name, ...it });
      }
    }
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    result.groups[gk] = { label: group.label, count: items.length, items: items.slice(0, 40) };
  }

  await writeJson('feeds-state.json', state);
  await writeJson('feeds.json', result);
  const total = Object.values(result.groups).reduce((s, g) => s + g.count, 0);
  log(`feeds: ${total} položek za posledních ${result.maxAgeHours} h, ${result.failed.length} zdrojů bez feedu`);
}

// ──────────────────────────────────────────────────────────── B) CENÍKY ────

const HIDE_COOKIES = `#onetrust-banner-sdk,#CybotCookiebotDialog,.cc-window,#cookiescript_injected,
  [id*="cookie" i][class*="banner" i],[class*="cookie" i][class*="consent" i],[id*="usercentrics" i]{display:none!important}`;

function extractPrices(text, hints) {
  const pat = new RegExp(
    String.raw`(?:\$|€|£)\s?\d[\d\s.,]{0,9}\d|\d[\d\s.,]{0,9}\d\s?(?:Kč|CZK|EUR|USD|PLN|zł)`,
    'g'
  );
  const found = (text.match(pat) || []).map((s) => s.replace(/\s+/g, ' ').trim());
  const uniq = [...new Set(found)];
  return uniq.slice(0, 50);
}

async function runPrices(browser) {
  const cfg = await readJson('pricing.json', null);
  if (!cfg || !cfg.targets) { log('prices: chybí pricing.json'); return; }
  const state = await readJson('prices-state.json', {});
  const todays = slice(cfg.targets, cfg.perDay || 12, 3);
  await ensureDir(`pricing-shots/${TODAY}`);
  const result = { generatedAt: new Date().toISOString(), checked: [], changes: [], errors: [] };

  for (const t of todays) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 1400 }, locale: 'cs-CZ' });
    const page = await ctx.newPage();
    try {
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.addStyleTag({ content: HIDE_COOKIES }).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 20000));
      const prices = extractPrices(text, cfg.currencyHints);
      const shot = `pricing-shots/${TODAY}/${t.key}.jpg`;
      await page.screenshot({ path: path.join(ROOT, shot), type: 'jpeg', quality: 72 });

      const before = state[t.key]?.prices || null;
      const entry = { key: t.key, url: t.url, own: !!t.own, cz: !!t.cz, prices, shot };
      result.checked.push(entry);

      if (before) {
        const added = prices.filter((p) => !before.includes(p));
        const removed = before.filter((p) => !prices.includes(p));
        if (added.length || removed.length) {
          result.changes.push({ ...entry, added, removed, since: state[t.key].date });
          log(`prices: ZMĚNA u ${t.key} (+${added.length} / -${removed.length})`);
        }
      }
      state[t.key] = { prices, date: TODAY, url: t.url };
    } catch (e) {
      result.errors.push({ key: t.key, url: t.url, error: String(e).slice(0, 200) });
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  await writeJson('prices-state.json', state);
  await writeJson('prices.json', result);
  log(`prices: zkontrolováno ${result.checked.length}, změn ${result.changes.length}, chyb ${result.errors.length}`);
}

// ─────────────────────────────────────────────────────────── C) E-MAILY ────

function absolutize(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

async function collectLinks(page, pattern) {
  return page.evaluate((pat) => {
    const out = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (h.includes(pat)) out.push({ href: h, text: (a.innerText || '').trim().slice(0, 120) });
    });
    return out;
  }, pattern);
}

async function shootEmail(browser, url, file) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1100, height: 1500 }, locale: 'en-US' });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.addStyleTag({ content: HIDE_COOKIES }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const title = (await page.title()) || '';
    await page.screenshot({ path: path.join(ROOT, file), type: 'jpeg', quality: 72 });
    return { ok: true, title: title.slice(0, 160) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function runEmails(browser) {
  const cfg = await readJson('email-sources.json', null);
  if (!cfg || !cfg.brands) { log('emails: chybí email-sources.json'); return; }
  const state = await readJson('email-sources-state.json', {});
  const todays = slice(cfg.brands, cfg.perDay || 8, 7);
  await ensureDir(`emails/${TODAY}`);
  const result = { generatedAt: new Date().toISOString(), brands: [], nothing: [], notes: [] };

  for (const brand of todays) {
    const st = state[brand.key] || { seen: [], fails: {}, working: null };
    const found = [];
    let usedSource = null;

    // 1) kurátorské galerie (renderují se JavaScriptem → potřebují prohlížeč)
    for (const g of cfg.galleries) {
      if (found.length >= (cfg.maxShotsPerBrand || 3)) break;
      const searchUrl = g.searchUrl.replace('{q}', encodeURIComponent(brand.q || brand.name));
      if ((st.fails[searchUrl] || 0) >= 3) continue;
      const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1200 }, locale: 'en-US' });
      const page = await ctx.newPage();
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForSelector(`a[href*="${g.itemPattern}"]`, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(SETTLE_MS);
        const links = await collectLinks(page, g.itemPattern);
        const urls = [...new Set(links.map((l) => absolutize(l.href, searchUrl)).filter(Boolean))];
        const fresh = urls.filter((u) => !st.seen.includes(u)).slice(0, cfg.maxShotsPerBrand || 3);
        if (!urls.length) { st.fails[searchUrl] = (st.fails[searchUrl] || 0) + 1; }
        else { st.fails[searchUrl] = 0; usedSource = usedSource || g.key; }
        await ctx.close().catch(() => {});

        for (const u of fresh) {
          const n = found.length + 1;
          const file = `emails/${TODAY}/${brand.key}--${g.key}-${n}.jpg`;
          const shot = await shootEmail(browser, u, file);
          if (shot.ok) { found.push({ source: g.key, url: u, title: shot.title, shot: file }); st.seen.push(u); }
        }
      } catch (e) {
        st.fails[searchUrl] = (st.fails[searchUrl] || 0) + 1;
        await ctx.close().catch(() => {});
      }
    }

    // 2) veřejný archiv na doméně značky nebo na beehiiv/substack
    if (!found.length && brand.site) {
      const candidates = (cfg.archiveTemplates || []).map((t) =>
        t.replace('{site}', brand.site.replace(/\/$/, '')).replace('{slug}', brand.slug || brand.key));
      const ordered = st.working ? [st.working, ...candidates.filter((c) => c !== st.working)] : candidates;
      for (const cand of ordered) {
        if ((st.fails[cand] || 0) >= 3) continue;
        const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1400 }, locale: 'en-US' });
        const page = await ctx.newPage();
        try {
          const resp = await page.goto(cand, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          const status = resp ? resp.status() : 0;
          const linkCount = await page.evaluate(() => document.querySelectorAll('a[href]').length);
          if (status && status < 400 && linkCount > 15) {
            await page.addStyleTag({ content: HIDE_COOKIES }).catch(() => {});
            await page.waitForTimeout(SETTLE_MS);
            const file = `emails/${TODAY}/${brand.key}--archiv.jpg`;
            await page.screenshot({ path: path.join(ROOT, file), type: 'jpeg', quality: 72 });
            const title = (await page.title()) || '';
            found.push({ source: 'archiv', url: cand, title: title.slice(0, 160), shot: file });
            st.working = cand; st.fails[cand] = 0; usedSource = usedSource || 'archiv';
            await ctx.close().catch(() => {});
            break;
          }
          st.fails[cand] = (st.fails[cand] || 0) + 1;
        } catch {
          st.fails[cand] = (st.fails[cand] || 0) + 1;
        } finally {
          await ctx.close().catch(() => {});
        }
      }
    }

    st.seen = st.seen.slice(-200);
    state[brand.key] = st;
    if (found.length) result.brands.push({ key: brand.key, name: brand.name, source: usedSource, found });
    else result.nothing.push({ key: brand.key, name: brand.name });
  }

  if (result.nothing.length) {
    result.notes.push('U těchto značek se dnes nepodařilo najít žádný veřejný e-mail. Když se to opakuje, je to samo o sobě zjištění: ta značka svoje kampaně veřejně nevystavuje.');
  }
  await writeJson('email-sources-state.json', state);
  await writeJson('emails.json', result);
  log(`emails: ${result.brands.length} značek s nálezem, ${result.nothing.length} bez`);
}

// ────────────────────────────────────────────────────────────────── běh ────

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  try { await runFeeds(); } catch (e) { log('feeds SPADLO:', e); }
  try { await runPrices(browser); } catch (e) { log('prices SPADLO:', e); }
  try { await runEmails(browser); } catch (e) { log('emails SPADLO:', e); }
} finally {
  await browser.close().catch(() => {});
}
log('extras: hotovo');
