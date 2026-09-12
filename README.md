# fotobot

Fotograf pro Stalkera — automatu, který každé ráno sleduje konkurenci Ecomailu
(e-mailingové a marketing-automation nástroje) a posílá nálezy do Slacku.

Stalker běží v cloudu, kde nemá prohlížeč ani přístup na cizí weby, takže sám
nevidí, jak co vypadá. Tenhle repozitář to řeší: fotky pořizuje GitHub, kam
Stalker přístup má.

## Jak to funguje

1. GitHub Actions se každý pracovní den v 5:40 UTC (7:40 v Praze) probudí,
   spustí Chromium a vyfotí všechny weby ze `targets.json`.
2. Fotky se uloží do repozitáře a commitnou.
3. Stalker si je pak stáhne přes `raw.githubusercontent.com` a skutečně se na
   ně podívá.

Ruční spuštění: záložka **Actions → fotobot → Run workflow**.

## Co kde leží

| Cesta | Co to je |
| --- | --- |
| `latest/<klic>.jpg` | aktuální první obrazovka, přepisuje se každý běh |
| `prev/<klic>.jpg` | totéž z předchozího běhu — pro srovnání před/po |
| `full/<klic>.jpg` | celá stránka, jen u cílů označených `"full": true` |
| `changed/<datum>/<klic>.jpg` | kopie fotky, **jen když se od minule změnila** |
| `queue-shots/<datum>/<klic>.jpg` | jednorázové fotky vyžádané přes `queue.txt` |
| `report.json` | co se povedlo, co spadlo, co se změnilo |

Repozitář neroste do nekonečna — `latest`, `prev` a `full` se přepisují.
Přibývá jen to, co se reálně změnilo.

## Téma dne — hloubková fáze

Kromě úvodních stránek fotograf každý den zpracuje **jedno téma** z
`page-types.json` (automatizace, ceník, šablony, integrace, o nás a kariéra —
rotují po dnech) a k němu **rotující partii konkurentů** (ve výchozím
nastavení 12 za den).

U každého z nich si sám najde odpovídající podstránky: přečte jeho
`sitemap.xml` (nebo, když žádná není, odkazy z navigace) a vybere adresy,
jejichž cesta odpovídá klíčovým slovům tématu. Blogy, nápovědu a články
přeskakuje.

**Ke stejnému tématu vyfotí i náš web** (adresy jsou v `us` u každého tématu).
Proto se Ecomail fotí jen tehdy, když je k čemu srovnávat — ne pro forma.

Výsledek: `deep/<datum>/<klic>--<tema>.jpg`, u našich stránek
`deep/<datum>/ecomail--<tema>.jpg`. V `report.json` je pole `tema` a seznam
`deep` s adresami a nalezenými H1.

Přidat téma nebo změnit klíčová slova = upravit `page-types.json`. `perDay`
říká, kolik konkurentů se za den zpracuje, `pagesPerSite` kolik podstránek
u každého.

## Náš web — hlídání nových stránek

Každý běh se navíc přečte naše sitemapa (`ownWatch` v `page-types.json`) a
vyfotí se stránky odpovídající vzorům (EMA `funkce/ai`, srovnávačky
`ecomail-vs-…`, alternativy) — ale **jen ty, které se ještě nikdy nefotily.**
První běh si celý seznam jen zapamatuje, ať se nezaplaví.

Výsledek: `deep/<datum>/ecomail--novinka--<slug>.jpg`, v reportu pole
`naseNovinky`.

Sledují se jen české stránky. PL a SK verze se záměrně nefotí.

## Složka `changed/` je radar

Pokud se fotka webu liší od té z minulého běhu, přistane její kopie do
`changed/<datum>/`. To je kandidát na redesign. Pozor, chytá to i banální
věci — otočený slider, jiný náhodný testimonial, A/B varianta, jiná cookie
lišta. Takže je to vodítko, ne důkaz. Ověřuje se pohledem na `prev` vs `latest`.

## Vyžádat fotku konkrétní stránky

Do `queue.txt` přidej řádek ve formátu:

```
klaviyo-kampan|https://www.klaviyo.com/nejaka-podstranka
```

Při dalším běhu se to vyfotí do `queue-shots/<datum>/`, řádek se z fronty
odstraní a zaloguje do `queue-done.txt`.

## Přidat nebo odebrat sledovaný web

Uprav `targets.json`:

```json
{ "key": "nazev-bez-mezer", "url": "https://adresa/", "cz": true, "full": true }
```

- `key` — název souboru s fotkou, jen písmena, číslice a pomlčky
- `cz` — jen příznak, že jde o český/slovenský trh
- `full` — vyfotit i celou stránku, ne jen první obrazovku

## Jak si fotky bere Stalker

Přes veřejné adresy:

```
https://raw.githubusercontent.com/fotobot-pro-drbnu/fotobot/main/latest/<klic>.jpg
https://raw.githubusercontent.com/fotobot-pro-drbnu/fotobot/main/prev/<klic>.jpg
https://raw.githubusercontent.com/fotobot-pro-drbnu/fotobot/main/report.json
```

(Funguje jen u veřejného repozitáře. U neveřejného je potřeba přihlášené
čtení přes GitHub API.)

## Čeho si být vědomý

- **Screenshot není pohled.** Animace, motion, hover stavy a interakce v tom
  nejsou. Cookie lišty se schovávají CSS pravidlem, ale nová varianta CMP může
  proklouznout.
- **Weby s ochranou proti robotům** můžou vracet blokaci nebo captchu. Objeví
  se v `report.json` jako chyba — do textu příspěvků to nikdy nepatří.
- **Fotky jsou z veřejně dostupných stránek** a slouží k internímu srovnání
  konkurence. Nepublikují se jako vlastní obsah.
- Když workflow spadne, fotky zestárnou. Stalker to musí poznat podle
  `report.json` (`runAt`) a v takovém případě o vzhledu neříkat nic.

## Předání dál

Všechno potřebné je v tomhle repozitáři. Nový vlastník:

1. Převede repozitář na svůj nebo firemní účet (Settings → Transfer).
2. V Actions zkontroluje, že workflow běží.
3. Zadání Stalkera (prompt naplánované úlohy v Claude Coworku) se zkopíruje
   beze změny — obsahuje pravidla, redakční kalibraci i adresy v tomhle repu.
