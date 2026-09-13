// extras.mjs — verze 2 (13. 9. 2026)
//
// Rozšíření fotobota o čtyři věci, které shoot.mjs nedělá:
//
//   A) FEEDY     — co za posledních 48 h vyšlo na blozích konkurence, v českém
//                  marketingovém tisku a v designových médiích   →  feeds.json
//   B) CENÍKY    — kolik si kdo účtuje, vyfocené i jako čísla, a co se změnilo
//                  oproti minulým dnům                           →  prices.json
//   C) E-MAILY   — skutečné newslettery konkurence i cizích značek, vyfocené
//                  z katalogů vzorníků a veřejných archivů       →  emails.json
//   D) ZÁCHRANKA — weby, které hlavnímu běhu spadly nebo se vyfotily rozbitě,
//                  zkusí znovu pomaleji a šetrněji               →  rescue.json
//
// Běží až PO shoot.mjs a je na něm nezávislý. Vždycky zapíše všechny výstupní
// soubory, i kdyby byly prázdné. Do fotek hlavního běhu nesahá.
//
// CO SE ZMĚNILO PROTI VERZI 1 (podle prvního ostrého běhu):
//   • Feedy: když prostý fetch neprojde (Cloudflare vrací 403 robotům), zkusí
//     se tatáž adresa přes prohlížeč. Design Week, Creative Review i MarTech
//     mají ověřeně platný feed a přesto jim verze 1 nedosáhla — tohle to řeší.
//   • E-maily: hledání podle značky (?q=, ?s=) nevrátilo ani jeden odkaz,
//     protože výsledky se dokreslují JavaScriptem. Nově se prochází rovnou
//     katalogové stránky a značka se pozná z adresy e-mailu. Když katalog
//     nevrátí nic, vyfotí se sám katalog jako důkaz, na co se robot díval.
//   • Ceníky: drží se historie posledních osmi záznamů, ne jen poslední.
//     Náš vlastní ceník se kontroluje každý den, ne jen když na něj přijde řada.
//
// Spuštění:  node extras.mjs

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().slice(0, 10);
const DOY = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 35000;
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

const HIDE_COOKIES = `#onetrust-banner-sdk,#CybotCookiebotDialog,.cc-window,#cookiescript_injected,
  [id*="cookie" i][class*="banner" i],[class*="cookie" i][class*="consent" i],[id*="usercentrics" i]{display:none!important}`;

// ───────────────────────────────────────────────────── stahování obsahu ────

async function grabPlain(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Záchrana pro weby, které prostý fetch odmítnou (403 pro roboty). Přes
// prohlížeč projde i Cloudflare; čte se surové tělo odpovědi, ne DOM.
async function grabViaBrowser(browser, url) {
  const ctx = await browser.newContext({ userAgent: UA, locale: 'cs-CZ' });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (!resp || !resp.ok()) return null;
    return await resp.text();
  } catch { return null; }
  finally { await ctx.close().catch(() => {}); }
}

// ───────────────────────────────────────────────────────────── A) FEEDY ────

const FEED_PATHS = ['/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/feed.xml', '/atom.xml',
  '/index.xml', '/blog/feed', '/blog/feed/', '/blog/rss.xml', '/blog/index.xml',
  '/news/feed/', '/en/feed/', '/cs/feed/'];

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

// Zkusí adresu nejdřív prostým fetchem, pak přes prohlížeč.
async function grabFeed(browser, url) {
  let body = await grabPlain(url);
  if (looksLikeFeed(body)) return { body, via: 'fetch' };
  body = await grabViaBrowser(browser, url);
  if (looksLikeFeed(body)) return { body, via: 'browser' };
  return null;
}

async function runFeeds(browser) {
  // POZOR: konfigurace je feeds-config.json, výstup je feeds.json.
  const cfg = await readJson('feeds-config.json', null);
  if (!cfg || !cfg.groups) { log('feeds: chybí konfigurace feeds-config.json'); return; }
  const state = await readJson('feeds-state.json', {});
  const maxAge = (cfg.maxAgeHours || 48) * 3600000;
  const now = Date.now();
  const result = { generatedAt: new Date().toISOString(), maxAgeHours: cfg.maxAgeHours || 48, groups: {}, discovered: {}, viaBrowser: [], failed: [] };

  for (const [gk, group] of Object.entries(cfg.groups)) {
    const items = [];
    for (const src of group.sources) {
      let feedUrl = src.feed || state[src.key]?.feed || null;
      let got = feedUrl ? await grabFeed(browser, feedUrl) : null;

      if (!got && src.site) {                      // hledání adresy feedu
        for (const p of FEED_PATHS) {
          const cand = src.site.replace(/\/$/, '') + p;
          const r = await grabFeed(browser, cand);
          if (r) { feedUrl = cand; got = r; break; }
        }
        if (got) { result.discovered[src.key] = feedUrl; log(`feeds: ${src.key} → ${feedUrl} (${got.via})`); }
      }
      if (!got) { result.failed.push({ key: src.key, name: src.name, reason: 'feed nenalezen ani přes prohlížeč' }); continue; }
      if (got.via === 'browser') result.viaBrowser.push(src.key);

      state[src.key] = { feed: feedUrl, via: got.via, ok: new Date().toISOString() };
      for (const it of parseFeed(got.body)) {
        if (it.ts && now - it.ts > maxAge) continue;
        items.push({ source: src.key, name: src.name, ...it });
      }
    }
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    result.groups[gk] = { label: group.label, count: items.length, items: items.slice(0, 40) };
  }

  await writeJson('feeds-state.json', state);
  await writeJson('feeds.json', result);
  const total = Object.values(result.groups).reduce((s, g) => s + g.count, 0);
  log(`feeds: ${total} položek, ${result.viaBrowser.length} zdrojů šlo jen přes prohlížeč, ${result.failed.length} bez feedu`);
}

// ──────────────────────────────────────────────────────────── B) CENÍKY ────

function extractPrices(text) {
  const pat = new RegExp(
    String.raw`(?:\$|€|£)\s?\d[\d\s.,]{0,9}\d|\d[\d\s.,]{0,9}\d\s?(?:Kč|CZK|EUR|USD|PLN|zł)`,
    'g'
  );
  return [...new Set((text.match(pat) || []).map((s) => s.replace(/\s+/g, ' ').trim()))].slice(0, 50);
}

async function runPrices(browser) {
  const cfg = await readJson('pricing.json', null);
  if (!cfg || !cfg.targets) { log('prices: chybí pricing.json'); return; }
  const state = await readJson('prices-state.json', {});
  const own = cfg.targets.filter((t) => t.own);
  const rest = cfg.targets.filter((t) => !t.own);
  const todays = [...slice(rest, cfg.perDay || 12, 3), ...own];   // náš ceník každý den
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
      const prices = extractPrices(text);
      const shot = `pricing-shots/${TODAY}/${t.key}.jpg`;
      await page.screenshot({ path: path.join(ROOT, shot), type: 'jpeg', quality: 72 });

      const prev = state[t.key];
      const entry = { key: t.key, url: t.url, own: !!t.own, cz: !!t.cz, prices, shot };
      result.checked.push(entry);

      if (prev?.prices) {
        const added = prices.filter((p) => !prev.prices.includes(p));
        const removed = prev.prices.filter((p) => !prices.includes(p));
        if (added.length || removed.length) {
          result.changes.push({ ...entry, added, removed, since: prev.date, history: (prev.history || []).slice(-4) });
          log(`prices: ZMĚNA u ${t.key} (+${added.length} / -${removed.length})`);
        }
      }
      const history = [...(prev?.history || []), { date: TODAY, prices }].slice(-8);
      state[t.key] = { prices, date: TODAY, url: t.url, history };
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

// Ke které sledované značce odkaz patří? Poznáme to z adresy.
function matchBrand(url, brands) {
  const u = url.toLowerCase();
  for (const b of brands) {
    const keys = [b.key, b.slug, ...(b.aliases || [])].filter(Boolean).map((s) => s.toLowerCase());
    if (keys.some((k) => u.includes(k))) return b;
  }
  return null;
}

async function shootPage(browser, url, file, viewport = { width: 1100, height: 1500 }) {
  const ctx = await browser.newContext({ userAgent: UA, viewport, locale: 'en-US' });
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
  if (!cfg || !cfg.catalogs) { log('emails: chybí email-sources.json'); return; }
  const state = await readJson('email-sources-state.json', { seen: [], catalogs: {}, archives: {} });
  state.seen ||= []; state.catalogs ||= {}; state.archives ||= {};
  await ensureDir(`emails/${TODAY}`);

  const result = {
    generatedAt: new Date().toISOString(),
    konkurence: [], inspirace: [], katalogy: [], archivy: [], poznamky: [],
  };
  let shots = 0;
  const maxShots = cfg.maxShotsPerRun || 7;

  // 1) KATALOGY — projdou se celé, značka se pozná z adresy
  const kandidati = { konkurence: [], ostatni: [] };
  for (const cat of slice(cfg.catalogs, cfg.catalogsPerDay || 3, 11)) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 1400 }, locale: 'en-US' });
    const page = await ctx.newPage();
    let links = [];
    try {
      await page.goto(cat.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.addStyleTag({ content: HIDE_COOKIES }).catch(() => {});
      // dolů a zpátky, ať se dokreslí lazy-loaded dlaždice
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      links = await page.evaluate((pat) => {
        const out = [];
        document.querySelectorAll('a[href]').forEach((a) => {
          const h = a.getAttribute('href') || '';
          if (h.includes(pat)) out.push(h);
        });
        return out;
      }, cat.itemPattern);

      const urls = [...new Set(links.map((h) => absolutize(h, cat.url)).filter(Boolean))];
      const zaznam = { key: cat.key, name: cat.name, url: cat.url, odkazu: urls.length };

      if (!urls.length) {
        // Důkaz, na co se robot díval — ať se to dá příště opravit.
        const file = `emails/${TODAY}/_katalog--${cat.key}.jpg`;
        await page.screenshot({ path: path.join(ROOT, file), type: 'jpeg', quality: 70 });
        zaznam.shot = file;
        zaznam.poznamka = 'žádné odkazy na jednotlivé e-maily — katalog vyfocen jako důkaz';
        state.catalogs[cat.key] = { fails: (state.catalogs[cat.key]?.fails || 0) + 1, date: TODAY };
      } else {
        state.catalogs[cat.key] = { fails: 0, date: TODAY, odkazu: urls.length };
        for (const u of urls) {
          if (state.seen.includes(u)) continue;
          const brand = matchBrand(u, cfg.brands);
          (brand ? kandidati.konkurence : kandidati.ostatni).push({ url: u, brand, cat: cat.key });
        }
      }
      result.katalogy.push(zaznam);
    } catch (e) {
      result.katalogy.push({ key: cat.key, url: cat.url, chyba: String(e).slice(0, 160) });
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // 2) FOCENÍ — konkurence má přednost, zbytek jako designová inspirace
  for (const k of kandidati.konkurence) {
    if (shots >= maxShots) break;
    const file = `emails/${TODAY}/${k.brand.key}--${k.cat}-${shots + 1}.jpg`;
    const s = await shootPage(browser, k.url, file);
    if (s.ok) {
      result.konkurence.push({ znacka: k.brand.name, key: k.brand.key, katalog: k.cat, url: k.url, title: s.title, shot: file });
      state.seen.push(k.url); shots++;
    }
  }
  let others = 0;
  for (const k of kandidati.ostatni) {
    if (shots >= maxShots || others >= (cfg.maxOtherShots || 3)) break;
    const file = `emails/${TODAY}/inspirace--${k.cat}-${others + 1}.jpg`;
    const s = await shootPage(browser, k.url, file);
    if (s.ok) {
      result.inspirace.push({ katalog: k.cat, url: k.url, title: s.title, shot: file });
      state.seen.push(k.url); shots++; others++;
    }
  }

  // 3) VEŘEJNÉ ARCHIVY na doméně značky (tudy se ve verzi 1 chytil ActiveCampaign)
  for (const brand of slice(cfg.brands, cfg.archiveBrandsPerDay || 6, 7)) {
    const st = state.archives[brand.key] || { working: null, fails: {} };
    const candidates = (cfg.archiveTemplates || []).map((t) =>
      t.replace('{site}', (brand.site || '').replace(/\/$/, '')).replace('{slug}', brand.slug || brand.key));
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
          result.archivy.push({ znacka: brand.name, key: brand.key, url: cand, title: title.slice(0, 160), shot: file });
          st.working = cand; st.fails[cand] = 0;
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
    state.archives[brand.key] = st;
  }

  state.seen = state.seen.slice(-400);
  const mrtveKatalogy = Object.entries(state.catalogs).filter(([, v]) => (v.fails || 0) >= 3).map(([k]) => k);
  if (mrtveKatalogy.length) result.poznamky.push(`Katalogy, které třikrát po sobě nic nevrátily: ${mrtveKatalogy.join(', ')}. Podívej se na jejich fotku v emails/<datum>/_katalog--*.jpg a uprav itemPattern v email-sources.json.`);
  if (!result.konkurence.length && !result.archivy.length) result.poznamky.push('Dnes se nenašel žádný e-mail konkurence. Když se to opakuje, nejde o chybu — ty značky svoje kampaně veřejně nevystavují.');

  await writeJson('email-sources-state.json', state);
  await writeJson('emails.json', result);
  log(`emails: konkurence ${result.konkurence.length}, inspirace ${result.inspirace.length}, archivy ${result.archivy.length}`);
}

// ──────────────────────────────────────────────────────── D) ZÁCHRANKA ────

async function runRescue(browser) {
  const report = await readJson('report.json', null);
  if (!report) { log('rescue: chybí report.json'); return; }
  const patients = [
    ...(report.failed || []).map((x) => ({ ...x, duvod: 'spadlo' })),
    ...(report.suspicious || []).map((x) => ({ ...x, duvod: 'rozbitá fotka' })),
  ].slice(0, 5);
  const result = { generatedAt: new Date().toISOString(), pacienti: patients.length, zachraneno: [], neuspech: [] };
  if (!patients.length) { await writeJson('rescue.json', result); log('rescue: nic k záchraně'); return; }
  await ensureDir(`rescue/${TODAY}`);

  for (const p of patients) {
    // Pomaleji a shovívavěji než hlavní běh: čeká se jen na první bajty
    // a dává se stránce 12 vteřin navíc, ať se dokreslí.
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 }, locale: 'cs-CZ' });
    const page = await ctx.newPage();
    try {
      await page.goto(p.url, { waitUntil: 'commit', timeout: 90000 });
      await page.waitForTimeout(12000);
      await page.addStyleTag({ content: HIDE_COOKIES }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const health = await page.evaluate(() => {
        const imgs = [...document.images];
        return {
          imgTotal: imgs.length,
          imgBroken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
          h1: (document.querySelector('h1')?.innerText || '').slice(0, 120),
          ruleCount: [...document.styleSheets].length,
        };
      });
      const file = `rescue/${TODAY}/${p.key}.jpg`;
      await page.screenshot({ path: path.join(ROOT, file), type: 'jpeg', quality: 75 });
      result.zachraneno.push({ key: p.key, url: p.url, duvod: p.duvod, shot: file, health });
      log(`rescue: ${p.key} zachráněn (${p.duvod})`);
    } catch (e) {
      result.neuspech.push({ key: p.key, url: p.url, duvod: p.duvod, error: String(e).slice(0, 160) });
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  await writeJson('rescue.json', result);
  log(`rescue: zachráněno ${result.zachraneno.length} z ${patients.length}`);
}

// ────────────────────────────────────────────────────────────────── běh ────

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  try { await runFeeds(browser); } catch (e) { log('feeds SPADLO:', e); }
  try { await runPrices(browser); } catch (e) { log('prices SPADLO:', e); }
  try { await runEmails(browser); } catch (e) { log('emails SPADLO:', e); }
  try { await runRescue(browser); } catch (e) { log('rescue SPADLO:', e); }
} finally {
  await browser.close().catch(() => {});
}
log('extras: hotovo');
