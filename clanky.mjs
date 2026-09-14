// clanky.mjs — hlídač článků na webech, které nepouštějí WebFetch (verze 1, 14. 9. 2026)
//
// PROČ TO EXISTUJE
// ecommercebridge.cz je český hub, kde se odehrává oborová debata o e-commerce
// a marketingu, a vychází tam pravidelný týdenní souhrn „Ecommerce Bridge UPDATE".
// Web ale vrací robotům bot-detection výzvu (HTTP 200 s Cloudflare stránkou),
// takže se k němu Stalker přes WebFetch nedostane a ve feedech skončí jako
// `blokovano`. Prohlížeč runneru projde tam, kam prostý fetch ne — ověřeno
// 14. 9. 2026 na czechdesignu. Tenhle skript to využívá.
//
// NENÍ TO JEN NA JEDEN WEB. Konfigurace je seznam, takže sem půjde přidat
// jakýkoli další zdroj, který nás blokuje (MarTech, Design Week, Creative Review…).
//
// ČTYŘI VRSTVY, ABY TO PŘEŽILO REDESIGN — stejná logika jako akce.mjs.
// Do výstupu se VŽDY zapíše, která vrstva zabrala (pole `metoda`), takže
// degradaci je vidět hned, místo aby skript tiše vracel nulu:
//
//   1) FEED (/feed/, /rss…) načtený prohlížečem. Nejlevnější a nejpřesnější:
//      má titulky, odkazy, data i perexy. Když je feed za blokací taky,
//      jde se dál.
//   2) JSON-LD (schema.org Article / NewsArticle / BlogPosting) na výpisu.
//      Weby to udržují kvůli SEO napříč redesigny.
//   3) ODKAZY podle vzoru v adrese + odečtení vzorů, které články nejsou
//      (autor, kategorie, tag…). Přežije přejmenování tříd i překopání layoutu.
//   4) ČISTÝ TEXT stránky. Nevrátí odkazy, ale je z něj vidět, že se něco děje.
//
// NAVÍC: TÝDENNÍ UPDATE SE NEHLEDÁ, POČÍTÁ SE.
// Adresa má tvar …/ecommerce-bridge-update-{tyden}-{rok}/ a číslo je ISO týden
// mínus jedna (vychází v pondělí a shrnuje týden předešlý). Ověřeno na osmi
// ročnících: 37/2026 vyšlo 14. 9. (ISO 38), 36/2026 7. 9. (ISO 37), 32/2026
// 10. 8. (ISO 33), 30/2026 27. 7., 29/2026 20. 7., 26/2026 30. 6., 11/2026
// 16. 3., 10/2026 9. 3. Skript zkusí posun −1, pak −2 a 0, a vezme první,
// který se otevře. Pokud se vzor jednou změní, uvidíme to jako `nenalezeno`
// se seznamem zkoušených adres, ne jako ticho.
//
// Výstup: clanky.json (vždy, i prázdný). Nesahá na nic jiného v repu
// a nevytváří datované složky, takže se nemusí uklízet.
//
// Spuštění:  node clanky.mjs

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CELKOVY_STROP_MS = 7 * 60 * 1000;
const start = Date.now();
const zbyva = () => CELKOVY_STROP_MS - (Date.now() - start);
const log = (...a) => console.log('[clanky]', ...a);

const writeJson = (file, data) =>
  fs.writeFile(path.join(ROOT, file), JSON.stringify(data, null, 2) + '\n');

// ── pomůcky na text ────────────────────────────────────────────────────────
// Bere první datum v textu. Zvládá „14. 9. 2026", „14.9.2026", ISO i RFC822.
function parseDatum(text) {
  const t = String(text || '');
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const cz = t.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (cz) {
    const s = `${cz[3]}-${String(cz[2]).padStart(2, '0')}-${String(cz[1]).padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(s))) return s;
  }
  const rfc = Date.parse(t.slice(0, 60));
  return Number.isNaN(rfc) ? null : new Date(rfc).toISOString().slice(0, 10);
}

// ISO týden podle ČSN/ISO 8601 — čtvrtek rozhoduje, do kterého roku týden patří.
function isoTyden(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const den = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - den);
  const rok = t.getUTCFullYear();
  const zacatek = new Date(Date.UTC(rok, 0, 1));
  return { rok, tyden: Math.ceil(((t - zacatek) / 86400000 + 1) / 7) };
}
// Posun o N týdnů zpět, korektně přes přelom roku (spočítá se z data, ne z čísla).
function tydenSPosunem(posun) {
  const d = new Date(Date.now() + posun * 7 * 86400000);
  return isoTyden(d);
}

// ── vrstva 1: feed ─────────────────────────────────────────────────────────
// Načítá se prohlížečem, protože prostý fetch je na těchhle webech zabitý.
// Parsuje se regulárním výrazem schválně: XML parser by se na jediné rozbité
// entitě zastavil celý, tohle vrátí aspoň to, co dává smysl.
function parseFeed(raw) {
  const src = String(raw || '');
  const bloky = src.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const vytahni = (blok, tag) => {
    const m = blok.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!m) return null;
    return m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim() || null;
  };
  return bloky.map((b) => {
    let url = vytahni(b, 'link');
    if (!url) { const m = b.match(/<link[^>]*href="([^"]+)"/i); url = m ? m[1] : null; }
    const datum = parseDatum(vytahni(b, 'pubDate') || vytahni(b, 'published') || vytahni(b, 'updated') || '');
    return {
      titul: (vytahni(b, 'title') || '').slice(0, 200),
      url,
      datum,
      perex: (vytahni(b, 'description') || vytahni(b, 'summary') || '').slice(0, 600) || null,
      autor: (vytahni(b, 'dc:creator') || vytahni(b, 'author') || '').slice(0, 120) || null,
    };
  }).filter((p) => p.titul && p.url);
}

// ── vrstva 2: JSON-LD ──────────────────────────────────────────────────────
const SBER_JSONLD = () => {
  const out = [];
  const pridej = (o) => {
    if (!o || typeof o !== 'object') return;
    const typ = [].concat(o['@type'] || []).join(' ');
    if (/(News|Blog)?(Article|Posting|Report)/i.test(typ) && o.headline) {
      const a = [].concat(o.author || [])[0];
      out.push({
        titul: String(o.headline).trim().slice(0, 200),
        url: (typeof o.url === 'string' ? o.url : o.mainEntityOfPage?.['@id']) || null,
        datum: o.datePublished ? String(o.datePublished).slice(0, 10) : null,
        perex: o.description ? String(o.description).slice(0, 600) : null,
        autor: (typeof a === 'string' ? a : a?.name) || null,
      });
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(pridej);
      else if (v && typeof v === 'object') pridej(v);
    }
  };
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try { pridej(JSON.parse(s.textContent || '{}')); } catch { /* rozbité JSON-LD přeskoč */ }
  }
  return out.filter((e) => e.titul);
};

// ── vrstva 3: odkazy podle vzoru + návrh nového vzoru ──────────────────────
const SBER_ODKAZY = ({ vzory, vynechat }) => {
  const norm = (h) => { try { return new URL(h, location.href).href; } catch { return null; } };
  const vsechny = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => ({ a, href: norm(a.getAttribute('href')) }))
    .filter((x) => x.href && x.href.startsWith(location.origin));

  const out = []; const videno = new Set();
  for (const { a, href } of vsechny) {
    if (vzory.length && !vzory.some((v) => href.includes(v))) continue;
    if (vynechat.some((v) => href.includes(v))) continue;
    const cesta = new URL(href).pathname.replace(/\/+$/, '');
    if (cesta.split('/').filter(Boolean).length < 1) continue;  // homepage
    if (videno.has(href)) continue;

    // Kontejner karty hledáme opatrně: jakmile by obsahoval víc než jeden
    // odkaz na článek, přestáváme lézt nahoru — jinak si karta přivlastní
    // datum od sousední. (Tahle chyba se v akce.mjs reálně stala.)
    let box = a;
    const jednoznacny = (el) => (el.querySelectorAll
      ? Array.from(el.querySelectorAll('a[href]'))
        .filter((x) => { try { const h = new URL(x.getAttribute('href'), location.href).href; return (!vzory.length || vzory.some((v) => h.includes(v))) && !vynechat.some((v) => h.includes(v)); } catch { return false; } })
        .length <= 1
      : true);
    // POZOR na podmínku ukončení. Zastavit se podle délky textu nejde:
    // u článku s dlouhým titulkem se tím zastavíme hned na <h2> a karta pak
    // nemá datum ani perex. Lezeme tedy nahoru, dokud je kontejner jednoznačný
    // (tj. neobsahuje druhý článkový odkaz), a držíme si poslední rozumný.
    // Strop na délce je jen pojistka proti spolknutí celého výpisu.
    for (let i = 0; i < 4 && box.parentElement; i++) {
      if (!jednoznacny(box.parentElement)) break;
      const vetsi = box.parentElement;
      if ((vetsi.innerText || '').trim().length > 1200) break;
      box = vetsi;
    }
    const titul = ((a.innerText || '').trim()
      || (box.querySelector('h1,h2,h3,h4')?.innerText || '').trim()
      || (a.getAttribute('aria-label') || '').trim()
      || (a.querySelector('img')?.getAttribute('alt') || '').trim());
    if (!titul || titul.length < 12) continue;   // „Více", „Číst dál" a podobné vata
    videno.add(href);
    out.push({ titul: titul.slice(0, 200), url: href, textKarty: (box.innerText || '').replace(/\s+\n/g, '\n').trim().slice(0, 400) });
  }

  // Kdyby vzor nezabral: nejčastější první segment cesty mezi odkazy.
  let navrhovanyVzor = null;
  if (out.length === 0) {
    const pocty = {};
    for (const { href } of vsechny) {
      const seg = new URL(href).pathname.split('/').filter(Boolean)[0];
      if (seg) pocty['/' + seg + '/'] = (pocty['/' + seg + '/'] || 0) + 1;
    }
    navrhovanyVzor = Object.entries(pocty).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([v, n]) => `${v} (${n}×)`).join(', ') || null;
  }
  return { polozky: out.slice(0, 60), navrhovanyVzor };
};

// ── vrstva 4: čistý text ───────────────────────────────────────────────────
const SBER_TEXT = () => ({
  text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000),
});

const SBER_META = () => {
  const g = (s) => document.querySelector(s)?.getAttribute('content') || null;
  return {
    ogTitle: g('meta[property="og:title"]'), ogDesc: g('meta[property="og:description"]'),
    published: g('meta[property="article:published_time"]'),
    autor: g('meta[name="author"]') || g('meta[property="article:author"]'),
    h1: (document.querySelector('h1')?.innerText || '').trim(),
  };
};

// ── otevírání stránek ──────────────────────────────────────────────────────
// Blokaci poznáme z titulku i z těla — Cloudflare vrací HTTP 200 s výzvou,
// takže samotný stavový kód nestačí. Hlavičky jsou nastavené na normální
// české Chrome, protože holé Playwright defaulty si weby všímají.
async function otevri(browser, url, settleMs, fn, opts = {}) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 1600 },
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
    extraHTTPHeaders: { 'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8' },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  try {
    const resp = await page.goto(url, { waitUntil: opts.waitUntil || 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(settleMs);
    const status = resp ? resp.status() : null;
    const titulStranky = await page.title().catch(() => '');
    const zacatekTela = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400)).catch(() => '');
    const vyzva = /just a moment|attention required|access denied|blocked|are you a robot|ověřujeme, že nejste robot|checking your browser/i;
    if (vyzva.test(titulStranky) || vyzva.test(zacatekTela)) {
      return { ok: false, blokovano: true, status, titulStranky };
    }
    if (status && status >= 400) return { ok: false, blokovano: false, status, titulStranky, chyba: 'HTTP ' + status };
    return { ok: true, blokovano: false, status, titulStranky, data: await fn(page) };
  } catch (e) {
    return { ok: false, blokovano: false, chyba: String(e).slice(0, 200) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Když to poprvé odpálkuje blokace, zkusí se to ještě jednou pomaleji.
// Stejný trik jako záchranka ve fotografovi: `commit` a delší usazení.
async function otevriSPojistkou(browser, url, settleMs, fn) {
  const prvni = await otevri(browser, url, settleMs, fn);
  if (prvni.ok || !prvni.blokovano || zbyva() < 60000) return prvni;
  log(`blokace na ${url} — druhý pokus pomaleji`);
  const druhy = await otevri(browser, url, Math.max(settleMs, 9000), fn, { waitUntil: 'commit' });
  return druhy.ok ? { ...druhy, pozn: 'prošlo až na druhý pokus' } : prvni;
}

// ── běh ────────────────────────────────────────────────────────────────────
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'clanky-config.json'), 'utf8'));
const dnes = new Date().toISOString().slice(0, 10);
const oknoOd = new Date(Date.now() - (cfg.oknoDnu || 10) * 86400000).toISOString().slice(0, 10);
const vysledek = {
  generatedAt: new Date().toISOString(), verze: 1, datum: dnes, oknoOd,
  zdroje: [], clanky: [], tydenniUpdate: [], poznamky: [],
};
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

try {
  let detailuCelkem = 0;

  for (const z of (cfg.zdroje || []).filter((x) => x.enabled !== false)) {
    if (zbyva() < 70000) { vysledek.poznamky.push(`${z.key}: přeskočeno, došel čas`); continue; }
    const vzory = [].concat(z.detailObsahuje || []).filter(Boolean);
    const vynechat = [].concat(z.vynechatVzory || []).filter(Boolean);

    const zaznam = {
      key: z.key, nazev: z.nazev, url: z.url, ok: false, blokovano: false,
      status: null, chyba: null, titulStranky: null,
      metoda: null, pocetPolozek: 0, feedUrl: null, navrhovanyVzor: null, textVypisu: null,
    };
    let polozky = [];

    // ── vrstva 1: feed ────────────────────────────────────────────────────
    for (const f of [].concat(z.feedKandidati || [])) {
      if (zbyva() < 60000) break;
      const v = await otevri(browser, f, 1500, async (page) =>
        ({ raw: await page.evaluate(() => document.documentElement.outerHTML).catch(() => '') }));
      if (!v.ok) { log(`${z.key}: feed ${f} — ${v.blokovano ? 'BLOKACE' : (v.chyba || 'nic')}`); continue; }
      const z1 = parseFeed(v.data.raw);
      if (z1.length) {
        zaznam.ok = true; zaznam.metoda = 'feed'; zaznam.feedUrl = f; zaznam.status = v.status;
        polozky = z1;
        log(`${z.key}: feed ${f} → ${z1.length} položek`);
        break;
      }
    }

    // ── vrstvy 2–4: výpis prohlížečem ─────────────────────────────────────
    if (!polozky.length) {
      const v = await otevriSPojistkou(browser, z.url, z.settleMs || 5000, async (page) => ({
        jsonld: await page.evaluate(SBER_JSONLD).catch(() => []),
        odkazy: await page.evaluate(SBER_ODKAZY, { vzory, vynechat }).catch(() => ({ polozky: [], navrhovanyVzor: null })),
        text: (await page.evaluate(SBER_TEXT).catch(() => ({ text: '' }))).text,
      }));
      zaznam.ok = v.ok; zaznam.blokovano = !!v.blokovano; zaznam.status = v.status || null;
      zaznam.chyba = v.chyba || null; zaznam.titulStranky = v.titulStranky || null;
      if (v.pozn) vysledek.poznamky.push(`${z.key}: ${v.pozn}`);

      if (v.ok) {
        const { jsonld, odkazy, text } = v.data;
        if (jsonld.length) {
          zaznam.metoda = 'jsonld';
          polozky = jsonld;
        } else if (odkazy.polozky.length) {
          zaznam.metoda = 'odkazy';
          polozky = odkazy.polozky.map((p) => ({ ...p, datum: parseDatum(p.textKarty), perex: null, autor: null }));
        } else {
          zaznam.metoda = 'text';
          zaznam.navrhovanyVzor = odkazy.navrhovanyVzor;
          zaznam.textVypisu = text.slice(0, 4000);
          vysledek.poznamky.push(`${z.key}: vzor adresy ${JSON.stringify(vzory)} nezabral ani JSON-LD nebyl — DEGRADOVÁNO na text. Navrhované vzory: ${odkazy.navrhovanyVzor || 'žádné'}`);
        }
      } else {
        vysledek.poznamky.push(`${z.key}: výpis se nepodařilo otevřít (${v.blokovano ? 'BLOKACE, prohlížeč nestačil' : (v.chyba || 'neznámo')}). Pokud je blokovano:true i podruhé, zdroj vypnout a nehlásit to znovu jako vadu.`);
      }
    }

    zaznam.pocetPolozek = polozky.length;
    vysledek.zdroje.push(zaznam);
    log(`${z.key}: metoda ${zaznam.metoda || 'nic'}, ${polozky.length} položek`);

    // ── výběr a detaily ───────────────────────────────────────────────────
    const kandidati = polozky
      .filter((p) => !p.datum || p.datum >= oknoOd)
      .sort((a, b) => String(b.datum || '0000').localeCompare(String(a.datum || '0000')));

    let vzato = 0;
    for (const k of kandidati) {
      const c = {
        zdroj: z.key, titul: k.titul, url: k.url || null, datum: k.datum || null,
        perex: k.perex || null, autor: k.autor || null,
        textKarty: k.textKarty || null, detail: null,
      };
      const beremDetail = k.url && vzato < (z.maxDetailu || 6)
        && detailuCelkem < (cfg.maxCelkemDetailu || 12) && zbyva() > 50000;
      if (beremDetail) {
        const d = await otevri(browser, k.url, 3000, async (page) => ({
          jsonld: await page.evaluate(SBER_JSONLD).catch(() => []),
          meta: await page.evaluate(SBER_META).catch(() => ({})),
          text: (await page.evaluate(SBER_TEXT).catch(() => ({ text: '' }))).text.slice(0, 3500),
        }));
        vzato++; detailuCelkem++;
        if (d.ok) {
          c.detail = { h1: d.data.meta?.h1 || null, meta: d.data.meta || null, text: d.data.text };
          const e = d.data.jsonld?.[0];
          c.datum = c.datum || (d.data.meta?.published ? String(d.data.meta.published).slice(0, 10) : null) || e?.datum || parseDatum(d.data.text);
          c.perex = c.perex || d.data.meta?.ogDesc || e?.perex || null;
          c.autor = c.autor || d.data.meta?.autor || e?.autor || null;
        } else {
          c.detail = { chyba: d.chyba || null, blokovano: !!d.blokovano };
        }
      }
      vysledek.clanky.push(c);
    }

    // ── týdenní UPDATE: adresa se počítá, nehledá ─────────────────────────
    if (z.tydenniVzor && zbyva() > 50000) {
      const posuny = [z.tydenPosun ?? -1, (z.tydenPosun ?? -1) - 1, 0];
      const zkousene = [];
      for (const p of posuny) {
        if (zbyva() < 45000) break;
        const { rok, tyden } = tydenSPosunem(p);
        const url = z.tydenniVzor.replace('{tyden}', String(tyden)).replace('{rok}', String(rok));
        if (zkousene.some((x) => x.url === url)) continue;
        const d = await otevri(browser, url, 3000, async (page) => ({
          meta: await page.evaluate(SBER_META).catch(() => ({})),
          text: (await page.evaluate(SBER_TEXT).catch(() => ({ text: '' }))).text.slice(0, 5000),
        }));
        zkousene.push({ url, ok: d.ok, status: d.status || null, blokovano: !!d.blokovano });
        if (d.ok && (d.data.meta?.h1 || d.data.text.length > 500)) {
          vysledek.tydenniUpdate.push({
            zdroj: z.key, tyden: `${tyden}/${rok}`, posun: p, url,
            titul: d.data.meta?.h1 || d.data.meta?.ogTitle || null,
            datum: d.data.meta?.published ? String(d.data.meta.published).slice(0, 10) : null,
            perex: d.data.meta?.ogDesc || null,
            text: d.data.text,
          });
          log(`${z.key}: týdenní UPDATE ${tyden}/${rok} nalezen (posun ${p})`);
          break;
        }
      }
      if (!vysledek.tydenniUpdate.some((u) => u.zdroj === z.key)) {
        vysledek.poznamky.push(`${z.key}: týdenní UPDATE nenalezen. Zkoušeno: ${zkousene.map((x) => x.url + ' → ' + (x.blokovano ? 'blokace' : (x.status || 'chyba'))).join(' | ')}. Buď ještě nevyšel, nebo se změnil vzor adresy — zkontrolovat ručně a upravit tydenniVzor.`);
      }
    }
  }
} catch (e) {
  vysledek.poznamky.push('clanky SPADLO: ' + String(e).slice(0, 300));
  log('SPADLO:', e);
} finally {
  await browser.close().catch(() => {});
  await writeJson('clanky.json', vysledek);
  const sDetailem = vysledek.clanky.filter((c) => c.detail && !c.detail.chyba).length;
  log(`hotovo: ${vysledek.clanky.length} článků, s detailem ${sDetailem}, týdenní UPDATE ${vysledek.tydenniUpdate.length}, metody: ${vysledek.zdroje.map((z) => z.key + '=' + (z.metoda || 'nic')).join(', ')}`);
}
