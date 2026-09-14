// akce.mjs — kalendáře přednášek a talků (verze 2, 14. 9. 2026)
//
// PROČ TO EXISTUJE
// czechdesign.cz je jediný zdroj, který agreguje pražské designové přednášky
// pro naši cílovku — a robotům vrací 403, takže se k němu Stalker přes WebFetch
// nedostane. Prohlížeč runneru tam projde (ověřeno 14. 9. 2026). Samotná fotka
// ale nestačí: je z ní vidět název a datum, ne kdo přednáší, kde to je a kolik
// to stojí. Bez toho kategorie „tip na přednášku" nesmí nic publikovat.
//
// JAK JE TO UDĚLANÉ, ABY TO PŘEŽILO REDESIGN
// Nikde se nespoléhá na názvy tříd ani na strukturu šablony. Zkouší se čtyři
// vrstvy od nejtrvanlivější k nejhrubší a do výstupu se VŽDY zapíše, která
// vrstva zabrala (pole `metoda`) — takže degradace je vidět okamžitě,
// místo aby skript tiše vracel nulu:
//
//   1) JSON-LD (schema.org Event) — strukturovaná data pro vyhledávače.
//      Weby je udržují napříč redesigny, protože na nich závisí jejich SEO.
//   2) ODKAZY podle vzoru v adrese (/kalendar-akci/…). Přežije přejmenování
//      tříd i překopání layoutu; rozbije se jen při změně URL schématu —
//      a na to je vrstva 4.
//   3) META a nadpisy na detailu (og:title, article:published_time, h1).
//   4) ČISTÝ TEXT stránky + hledání dat regulárním výrazem. Tohle funguje,
//      dokud je na stránce vůbec nějaké datum. Nevrátí odkazy, ale vrátí
//      seznam názvů a dat, takže víme, že se něco děje.
//
// A ještě jedna pojistka: když vzor adresy nezabere, skript si sám zjistí
// nejčastější cestu odkazů na stránce a napíše ji do výstupu jako
// `navrhovanyVzor`. Když tedy czechdesign přejmenuje /kalendar-akci/ na /akce/,
// nedozvíme se „nic tam není", ale „vzor se změnil, zkus tenhle".
//
// Výstup: akce.json (vždy, i prázdný). Nesahá na nic jiného v repu
// a nevytváří datované složky, takže se nemusí uklízet.
//
// Spuštění:  node akce.mjs

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CELKOVY_STROP_MS = 8 * 60 * 1000;
const start = Date.now();
const zbyva = () => CELKOVY_STROP_MS - (Date.now() - start);
const log = (...a) => console.log('[akce]', ...a);

const writeJson = (file, data) =>
  fs.writeFile(path.join(ROOT, file), JSON.stringify(data, null, 2) + '\n');

// ── pomůcky na text ────────────────────────────────────────────────────────
// Bere první datum v textu. Zvládá „17. 9. 2026", „15.10.2026" i ISO.
function parseDatum(text) {
  const t = String(text || '');
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const cz = t.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (cz) {
    const s = `${cz[3]}-${String(cz[2]).padStart(2, '0')}-${String(cz[1]).padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(s))) return s;
  }
  return null;
}
function vytahniCenu(text) {
  const t = String(text || '');
  if (/\bvstup\s*(je)?\s*(zdarma|free)\b|\bzdarma\b|\bbez vstupného\b|\bfree entry\b/i.test(t)) return 'zdarma (podle textu stránky)';
  const m = t.match(/(\d[\d\s]{1,8})\s*(Kč|CZK|EUR|€|\$|USD)/i);
  return m ? `${m[1].replace(/\s+/g, ' ').trim()} ${m[2]}` : null;
}
function vytahniMisto(text) {
  const radky = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  return (radky.find(r => /^(místo|kde|adresa|venue)\s*[:\-–]/i.test(r))
    || radky.find(r => r.length < 120 && /\b(Praha|Brno|Ostrava|Plzeň|Olomouc|online)\b/i.test(r))
    || '').slice(0, 160) || null;
}

// ── vrstva 1: JSON-LD ──────────────────────────────────────────────────────
// Vrací pole akcí ze schema.org. Nezajímá nás struktura stránky vůbec.
const SBER_JSONLD = () => {
  const out = [];
  const pridej = (o) => {
    if (!o || typeof o !== 'object') return;
    const typ = [].concat(o['@type'] || []).join(' ');
    if (/Event/i.test(typ)) {
      const loc = o.location;
      const mistoTxt = typeof loc === 'string' ? loc
        : loc ? [loc.name, loc.address && (typeof loc.address === 'string' ? loc.address
            : [loc.address.streetAddress, loc.address.addressLocality].filter(Boolean).join(', '))]
            .filter(Boolean).join(', ') : null;
      const of = [].concat(o.offers || [])[0];
      out.push({
        titul: String(o.name || '').trim().slice(0, 200),
        url: o.url || null,
        datum: o.startDate ? String(o.startDate).slice(0, 10) : null,
        datumDo: o.endDate ? String(o.endDate).slice(0, 10) : null,
        misto: mistoTxt ? String(mistoTxt).slice(0, 200) : null,
        cena: of ? (of.price != null ? `${of.price} ${of.priceCurrency || ''}`.trim() : (of.name || null)) : null,
        popis: o.description ? String(o.description).slice(0, 800) : null,
        performer: [].concat(o.performer || []).map(p => (typeof p === 'string' ? p : p?.name)).filter(Boolean).join(', ') || null,
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
  return out.filter(e => e.titul);
};

// ── vrstva 2: odkazy podle vzoru + návrh nového vzoru ──────────────────────
const SBER_ODKAZY = (vzory) => {
  const norm = (h) => { try { return new URL(h, location.href).href; } catch { return null; } };
  const vsechny = Array.from(document.querySelectorAll('a[href]'))
    .map(a => ({ a, href: norm(a.getAttribute('href')) }))
    .filter(x => x.href && x.href.startsWith(location.origin));

  const out = []; const videno = new Set();
  for (const { a, href } of vsechny) {
    if (!vzory.some(v => href.includes(v))) continue;
    if (videno.has(href)) continue;
    // Kontejner karty hledáme opatrně: jakmile by obsahoval víc než jeden
    // odkaz odpovídající vzoru, přestáváme lézt nahoru. Bez toho si karta
    // přivlastní datum od sousední — ověřeno testem, stalo se.
    let box = a;
    const jednoznacny = (el) => el.querySelectorAll
      ? Array.from(el.querySelectorAll('a[href]'))
          .filter(x => { try { return vzory.some(v => new URL(x.getAttribute('href'), location.href).href.includes(v)); } catch { return false; } })
          .length <= 1
      : true;
    for (let i = 0; i < 4 && box.parentElement; i++) {
      if (!jednoznacny(box.parentElement)) break;
      box = box.parentElement;
      if ((box.innerText || '').trim().length > 40) break;
    }
    const titul = ((a.innerText || '').trim()
      || (box.querySelector('h1,h2,h3,h4')?.innerText || '').trim()
      || (a.getAttribute('aria-label') || '').trim()
      || (a.querySelector('img')?.getAttribute('alt') || '').trim());
    if (!titul) continue;
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
  return { polozky: out.slice(0, 80), navrhovanyVzor };
};

// ── vrstva 4: čistý text ───────────────────────────────────────────────────
const SBER_TEXT = () => ({
  text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000),
});

async function otevri(browser, url, settleMs, fn) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 1600 }, locale: 'cs-CZ' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(settleMs);
    const titulStranky = await page.title().catch(() => '');
    // Blokaci poznáme z titulku — Cloudflare i podobné výzvy vracejí HTTP 200.
    if (/just a moment|attention required|access denied|blocked|are you a robot/i.test(titulStranky)) {
      return { ok: false, blokovano: true, titulStranky };
    }
    return { ok: true, blokovano: false, titulStranky, data: await fn(page) };
  } catch (e) {
    return { ok: false, blokovano: false, chyba: String(e).slice(0, 200) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── běh ────────────────────────────────────────────────────────────────────
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'akce-config.json'), 'utf8'));
const dnes = new Date().toISOString().slice(0, 10);
const hranice = new Date(Date.now() + (cfg.oknoDnu || 75) * 86400000).toISOString().slice(0, 10);
const vysledek = {
  generatedAt: new Date().toISOString(), verze: 2, datum: dnes, oknoDo: hranice,
  zdroje: [], akce: [], poznamky: [],
};
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

try {
  let detailuCelkem = 0;
  for (const z of (cfg.zdroje || []).filter(x => x.enabled !== false)) {
    if (zbyva() < 70000) { vysledek.poznamky.push(`${z.key}: přeskočeno, došel čas`); continue; }
    const vzory = [].concat(z.detailObsahuje || []).filter(Boolean);

    const v = await otevri(browser, z.url, z.settleMs || 5000, async (page) => ({
      jsonld: await page.evaluate(SBER_JSONLD).catch(() => []),
      odkazy: await page.evaluate(SBER_ODKAZY, vzory).catch(() => ({ polozky: [], navrhovanyVzor: null })),
      text: (await page.evaluate(SBER_TEXT).catch(() => ({ text: '' }))).text,
    }));

    const zaznamZdroje = {
      key: z.key, nazev: z.nazev, url: z.url, ok: v.ok, blokovano: !!v.blokovano,
      chyba: v.chyba || null, titulStranky: v.titulStranky || null,
      metoda: null, pocetPolozek: 0, navrhovanyVzor: null, textVypisu: null,
    };
    if (!v.ok) { vysledek.zdroje.push(zaznamZdroje); log(`${z.key}: ${v.blokovano ? 'BLOKACE' : v.chyba}`); continue; }

    const { jsonld, odkazy, text } = v.data;
    let polozky = [];
    if (jsonld.length) {
      zaznamZdroje.metoda = 'jsonld';
      polozky = jsonld.map(e => ({ titul: e.titul, url: e.url, datum: e.datum, textKarty: e.popis || '', zJsonLd: e }));
    } else if (odkazy.polozky.length) {
      zaznamZdroje.metoda = 'odkazy';
      polozky = odkazy.polozky.map(p => ({ ...p, datum: parseDatum(p.textKarty) }));
    } else {
      // Nejhrubší vrstva: aspoň názvy a data z textu, ať nevrátíme prázdno.
      zaznamZdroje.metoda = 'text';
      zaznamZdroje.navrhovanyVzor = odkazy.navrhovanyVzor;
      zaznamZdroje.textVypisu = text.slice(0, 4000);
      vysledek.poznamky.push(`${z.key}: vzor adresy ${JSON.stringify(vzory)} nezabral ani JSON-LD nebyl — DEGRADOVÁNO na text. Navrhované vzory: ${odkazy.navrhovanyVzor || 'žádné'}`);
    }
    zaznamZdroje.pocetPolozek = polozky.length;
    vysledek.zdroje.push(zaznamZdroje);
    log(`${z.key}: metoda ${zaznamZdroje.metoda}, ${polozky.length} položek`);

    const kandidati = polozky
      .filter(p => !p.datum || (p.datum >= dnes && p.datum <= hranice))
      .sort((a, b) => (a.datum || '9999').localeCompare(b.datum || '9999'));

    let vzato = 0;
    for (const k of kandidati) {
      const z1 = {
        zdroj: z.key, titul: k.titul, url: k.url || null, datum: k.datum,
        textKarty: k.textKarty || null, jsonld: k.zJsonLd || null,
        detail: null, cena: k.zJsonLd?.cena || null, misto: k.zJsonLd?.misto || null,
        prednasejici: k.zJsonLd?.performer || null,
      };
      const beremDetail = k.url && vzato < (z.maxDetailu || 6)
        && detailuCelkem < (cfg.maxCelkemDetailu || 14) && zbyva() > 50000;
      if (beremDetail) {
        const d = await otevri(browser, k.url, 3500, async (page) => ({
          jsonld: await page.evaluate(SBER_JSONLD).catch(() => []),
          meta: await page.evaluate(() => {
            const g = (s) => document.querySelector(s)?.getAttribute('content') || null;
            return {
              ogTitle: g('meta[property="og:title"]'), ogDesc: g('meta[property="og:description"]'),
              published: g('meta[property="article:published_time"]'),
              h1: (document.querySelector('h1')?.innerText || '').trim(),
            };
          }).catch(() => ({})),
          text: (await page.evaluate(SBER_TEXT).catch(() => ({ text: '' }))).text.slice(0, 3000),
        }));
        vzato++; detailuCelkem++;
        if (d.ok) {
          z1.detail = { h1: d.data.meta?.h1 || null, meta: d.data.meta || null, text: d.data.text };
          const e = d.data.jsonld?.[0];
          if (e) { z1.jsonld = z1.jsonld || e; z1.cena = z1.cena || e.cena; z1.misto = z1.misto || e.misto; z1.prednasejici = z1.prednasejici || e.performer; }
          z1.datum = z1.datum || e?.datum || parseDatum(d.data.text);
          z1.cena = z1.cena || vytahniCenu(d.data.text);
          z1.misto = z1.misto || vytahniMisto(d.data.text);
        } else {
          z1.detail = { chyba: d.chyba || null, blokovano: !!d.blokovano };
        }
      }
      vysledek.akce.push(z1);
    }
  }
} catch (e) {
  vysledek.poznamky.push('akce SPADLO: ' + String(e).slice(0, 300));
  log('SPADLO:', e);
} finally {
  await browser.close().catch(() => {});
  await writeJson('akce.json', vysledek);
  const sDetailem = vysledek.akce.filter(a => a.detail && !a.detail.chyba).length;
  log(`hotovo: ${vysledek.akce.length} akcí, s detailem ${sDetailem}, metody: ${vysledek.zdroje.map(z => z.key + '=' + (z.metoda || 'nic')).join(', ')}`);
}
