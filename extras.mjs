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
// Jak dlouho se drží datované fotky. Sledujeme aktuality, ne archiv —
// co je starší, se maže i s tím, že na to můžou vést staré odkazy.
const RETENTION_DAYS = 60;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 35000;
const SETTLE_MS = 3500;
// Slušnost k cizím serverům. Běh z 13.9. schytal 429 („moc dotazů") od MAM,
// MailerLite i ActiveCampaign — dělali jsme si to sami tím, jak rychle po
// sobě robot tloukl na tytéž domény. Držíme mezeru mezi dotazy na JEDEN host.
const MIN_HOST_GAP = 2500;
// Když u zdroje nenajdeme feed, nezkoušíme těch patnáct adres znovu každý
// den — počká se dva týdny. Šetří to čas běhu i nervy protistrany.
const NO_FEED_COOLDOWN_DAYS = 14;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lastHit = new Map();
async function politeWait(url) {
  let host;
  try { host = new URL(url).host; } catch { return; }
  const prev = lastHit.get(host) || 0;
  const wait = prev + MIN_HOST_GAP - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

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

// Cloudflare a spol. runner z datacentra často odmítnou. Je rozdíl mezi
// „stránka nic nevrátila" a „vyhodili nás" — druhé nemá cenu zkoušet dokola
// a hlavně to není nález o tom webu, ale o nás.
const BLOCK_MARKERS = [
  'you have been blocked', 'attention required', 'access denied',
  'checking your browser', 'cf-error-details', 'just a moment...',
  'request blocked', 'error 1015', 'ddos protection by',
];
function looksBlocked(text) {
  if (!text) return false;
  const t = text.slice(0, 4000).toLowerCase();
  return BLOCK_MARKERS.some((m) => t.includes(m));
}

// ───────────────────────────────────────────────────── stahování obsahu ────

async function grabPlain(url, retry = true) {
  await politeWait(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    // 429 = „moc dotazů". Jednou počkáme (podle Retry-After, nejvýš 20 s) a
    // zkusíme to znovu — teprve pak to hlásíme jako blokaci.
    if ((r.status === 429 || r.status === 503) && retry) {
      const hdr = parseInt(r.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(hdr) ? Math.min(hdr * 1000, 20000) : 8000;
      log(`  ${r.status} u ${url} — čekám ${Math.round(wait / 1000)} s a zkouším znovu`);
      await sleep(wait);
      return grabPlain(url, false);
    }
    if (!r.ok) return { ok: false, status: r.status, body: null };
    return { ok: true, status: r.status, body: await r.text() };
  } catch { return { ok: false, status: 0, body: null }; }
  finally { clearTimeout(t); }
}

// Záchrana pro weby, které prostý fetch odmítnou (403 pro roboty). Přes
// prohlížeč projde i Cloudflare; čte se surové tělo odpovědi, ne DOM.
async function grabViaBrowser(browser, url) {
  const ctx = await browser.newContext({ userAgent: UA, locale: 'cs-CZ' });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (!resp) return { ok: false, status: 0, body: null };
    // Tělo čteme i u chybového kódu — potřebujeme poznat, jestli nás vyhodili.
    const body = await resp.text().catch(() => null);
    return { ok: resp.ok(), status: resp.status(), body };
  } catch { return { ok: false, status: 0, body: null }; }
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

// Zkusí adresu nejdřív prostým fetchem, pak přes prohlížeč. Když nás web
// vyhodí, vrátí to jako `blocked` — ať se to nehlásí jako „feed neexistuje".
async function grabFeed(browser, url, allowBrowser = true) {
  const plain = await grabPlain(url);
  if (looksLikeFeed(plain.body)) return { body: plain.body, via: 'fetch' };
  if (!allowBrowser) {
    // Hledáme teprve adresu feedu — prohlížeč sem netaháme, jinak by jeden
    // zdroj znamenal třicet dotazů místo patnácti a běh by trval věčnost.
    if (plain.status === 403 || plain.status === 429) return { blocked: true, status: plain.status };
    return null;
  }
  await politeWait(url);
  const r = await grabViaBrowser(browser, url);
  if (looksLikeFeed(r.body)) return { body: r.body, via: 'browser' };
  if (looksBlocked(r.body) || r.status === 403 || r.status === 429 || plain.status === 403 || plain.status === 429) {
    return { blocked: true, status: r.status || plain.status };
  }
  return null;
}

async function runFeeds(browser) {
  // POZOR: konfigurace je feeds-config.json, výstup je feeds.json.
  const cfg = await readJson('feeds-config.json', null);
  if (!cfg || !cfg.groups) { log('feeds: chybí konfigurace feeds-config.json'); return; }
  const state = await readJson('feeds-state.json', {});
  const maxAge = (cfg.maxAgeHours || 48) * 3600000;
  const now = Date.now();
  const result = { generatedAt: new Date().toISOString(), maxAgeHours: cfg.maxAgeHours || 48, groups: {}, discovered: {}, viaBrowser: [], blokovano: [], failed: [] };

  for (const [gk, group] of Object.entries(cfg.groups)) {
    const items = [];
    for (const src of group.sources) {
      let feedUrl = src.feed || state[src.key]?.feed || null;
      let got = feedUrl ? await grabFeed(browser, feedUrl) : null;

      const cooldown = state[src.key]?.noFeedUntil;
      const naLedu = cooldown && Date.parse(cooldown) > now;

      if ((!got || got.blocked) && src.site && !naLedu) {   // hledání adresy feedu
        // Nejdřív prostým fetchem přes všechny kandidáty — levné a rychlé.
        for (const p of FEED_PATHS) {
          const cand = src.site.replace(/\/$/, '') + p;
          const r = await grabFeed(browser, cand, false);
          if (r && !r.blocked) { feedUrl = cand; got = r; break; }
          if (r && r.blocked) got = r;             // blokaci si pamatuj, ale zkoušej dál
        }
        // Teprve když nic neprošlo, jeden pokus přes prohlížeč na hlavní
        // adresu. Tímhle se minule chytil Boldem, tak o to nechceme přijít.
        if (!got || got.blocked) {
          const cand = src.site.replace(/\/$/, '') + FEED_PATHS[0];
          const r = await grabFeed(browser, cand, true);
          if (r && !r.blocked) { feedUrl = cand; got = r; }
          else if (r && r.blocked) got = r;
        }
        if (got && !got.blocked) {
          result.discovered[src.key] = feedUrl;
          log(`feeds: ${src.key} → ${feedUrl} (${got.via})`);
        } else if (!got) {
          // Marné hledání si poznamenáme, ať se neopakuje každý den.
          state[src.key] = { ...(state[src.key] || {}), noFeedUntil: new Date(now + NO_FEED_COOLDOWN_DAYS * 86400000).toISOString() };
        }
      }
      if (naLedu && !got) {
        result.failed.push({ key: src.key, name: src.name, reason: `feed se nenašel, další hledání až po ${state[src.key].noFeedUntil.slice(0, 10)}` });
        continue;
      }
      if (got && got.blocked) {
        result.blokovano.push({ key: src.key, name: src.name, status: got.status });
        log(`feeds: ${src.key} NÁS BLOKUJE (${got.status})`);
        continue;
      }
      if (!got) { result.failed.push({ key: src.key, name: src.name, reason: 'feed nenalezen ani přes prohlížeč' }); continue; }
      if (got.via === 'browser') result.viaBrowser.push(src.key);

      state[src.key] = { feed: feedUrl, via: got.via, ok: new Date().toISOString() };  // úspěch ruší cooldown
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
  log(`feeds: ${total} položek, ${result.viaBrowser.length} přes prohlížeč, ${result.blokovano.length} nás blokuje, ${result.failed.length} bez feedu`);
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
  const result = { generatedAt: new Date().toISOString(), checked: [], changes: [], nenacteno: [], errors: [] };

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

      // Když se z ceníku nevytáhla ANI JEDNA cena, stránka se nenačetla.
      // Není to zlevnění, je to naše chyba — a stav se nepřepisuje, ať se
      // příště porovnává proti poslední rozumné hodnotě.
      if (!prices.length) {
        result.nenacteno.push({ key: t.key, url: t.url, shot, drzeloPredtim: prev?.prices?.length || 0 });
        log(`prices: ${t.key} — žádná cena, ceník se nenačetl (nehlásím jako změnu)`);
        continue;
      }

      if (prev?.prices?.length) {
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
  log(`prices: zkontrolováno ${result.checked.length}, změn ${result.changes.length}, nenačteno ${result.nenacteno.length}, chyb ${result.errors.length}`);
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
  const zivéKatalogy = cfg.catalogs.filter((c) => c.enabled !== false && !(state.catalogs[c.key]?.blokovano && (state.catalogs[c.key]?.fails || 0) >= 2));
  for (const cat of slice(zivéKatalogy, cfg.catalogsPerDay || 3, 11)) {
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

      // Rozliš „nic tam nebylo" od „vyhodili nás". To druhé nemá cenu ladit.
      if (!urls.length) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '');
        if (looksBlocked(bodyText)) {
          const file = `emails/${TODAY}/_katalog--${cat.key}.jpg`;
          await page.screenshot({ path: path.join(ROOT, file), type: 'jpeg', quality: 70 }).catch(() => {});
          zaznam.shot = file;
          zaznam.blokovano = true;
          zaznam.poznamka = 'web nás blokuje (Cloudflare) — není to chyba vzorku odkazů, tudy cesta nevede';
          state.catalogs[cat.key] = { blokovano: true, date: TODAY, fails: (state.catalogs[cat.key]?.fails || 0) + 1 };
          result.katalogy.push(zaznam);
          await ctx.close().catch(() => {});
          continue;
        }
      }

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

// ───────────────────────────────────── D) DENNÍ ARCHIV FOTEK (datované) ────
//
// `latest/` se každý běh přepisuje, takže odkaz na fotku v odeslaném
// příspěvku by za pár dní ukazoval něco jiného. Proto se z každé dnešní
// fotky udělá zmenšená datovaná kopie do `daily/<datum>/`. Na tu se dá
// odkazovat a nezmění se pod rukama.

async function runDaily() {
  const src = path.join(ROOT, 'latest');
  let files = [];
  try { files = (await fs.readdir(src)).filter((f) => f.endsWith('.jpg')); }
  catch { log('daily: složka latest/ neexistuje'); return; }
  if (!files.length) { log('daily: latest/ je prázdná'); return; }

  await ensureDir(`daily/${TODAY}`);
  let sharp = null;
  try { sharp = (await import('sharp')).default; } catch { /* zmenšovat nemusíme */ }

  let ok = 0, bytes = 0;
  for (const f of files) {
    const from = path.join(src, f);
    const to = path.join(ROOT, 'daily', TODAY, f);
    try {
      if (sharp) {
        await sharp(from).resize({ width: 1000, withoutEnlargement: true })
          .jpeg({ quality: 62 }).toFile(to);
      } else {
        await fs.copyFile(from, to);
      }
      bytes += (await fs.stat(to)).size; ok++;
    } catch (e) { /* jedna fotka navíc nestojí za spadlý běh */ }
  }
  await writeJson('daily.json', {
    generatedAt: new Date().toISOString(), datum: TODAY, pocet: ok,
    velikostMB: +(bytes / 1048576).toFixed(1),
    poznamka: 'Datované kopie fotek z latest/. Na tyhle cesty se dá odkazovat v příspěvcích — nepřepisují se. Drží se ' + RETENTION_DAYS + ' dní.',
  });
  log(`daily: ${ok} fotek do daily/${TODAY} (${(bytes / 1048576).toFixed(1)} MB)`);
}

// ─────────────────────────────────────────────── E) ÚKLID STARÝCH FOTEK ────
//
// Sledujeme aktuality, ne archiv. Co je starší než RETENTION_DAYS, jde pryč
// — včetně vědomí, že na to můžou vést staré odkazy ve Slacku.

async function runCleanup() {
  const dirs = ['daily', 'changed', 'deep', 'emails', 'pricing-shots', 'rescue', 'queue-shots'];
  const hranice = Date.now() - RETENTION_DAYS * 86400000;
  const smazano = [];
  for (const d of dirs) {
    let sub = [];
    try { sub = await fs.readdir(path.join(ROOT, d), { withFileTypes: true }); } catch { continue; }
    for (const e of sub) {
      if (!e.isDirectory()) continue;
      const t = Date.parse(e.name);                 // složky se jmenují podle data
      if (Number.isNaN(t) || t >= hranice) continue;
      try {
        await fs.rm(path.join(ROOT, d, e.name), { recursive: true, force: true });
        smazano.push(`${d}/${e.name}`);
      } catch { /* nevadí */ }
    }
  }
  if (smazano.length) log(`úklid: smazáno ${smazano.length} složek starších než ${RETENTION_DAYS} dní`);
  else log(`úklid: nic staršího než ${RETENTION_DAYS} dní`);
  return smazano;
}

// ──────────────────────────────────────────────────────── F) ZÁCHRANKA ────

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
  try { await runDaily(); } catch (e) { log('daily SPADLO:', e); }
  try { await runCleanup(); } catch (e) { log('úklid SPADL:', e); }
} finally {
  await browser.close().catch(() => {});
}
log('extras: hotovo');
