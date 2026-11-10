const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
// Dozvoljeno samo s The Eventer stranice i Netlify chata (drugi ne mogu trošiti tvoj AI kredit)
const ALLOWED_ORIGINS = [
  'https://www.the-eventer.com',
  'https://the-eventer.com',
  'https://glistening-mochi-d59956.netlify.app',
];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) || /\.webflow\.io$/.test(origin)),
}));
app.use(express.json({ limit: '100kb' }));

const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PARTNERS_COLLECTION_ID = '68307c1dadce0e018f4ac397';
const CATEGORIES_COLLECTION_ID = '682f2e1d88bb99722fa49d6c';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Cache za partnere (10 minuta)
let partnersCache = null;
let categoriesCache = null;
let cacheTime = null;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minuta

async function fetchAllItems(collectionId) {
  let allItems = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await axios.get(
      `https://api.webflow.com/v2/collections/${collectionId}/items/live`,
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
          'accept-version': '2.0.0',
        },
        params: { limit, offset },
      }
    );

    const items = response.data.items || [];
    allItems = allItems.concat(items);

    if (items.length < limit) break;
    offset += limit;
  }

  return allItems;
}

async function fetchCategoryOptions() {
  // "Vrsta usluge" je Option polje — nazivi opcija su u shemi kolekcije
  const res = await axios.get(`https://api.webflow.com/v2/collections/${PARTNERS_COLLECTION_ID}`, {
    headers: { Authorization: `Bearer ${WEBFLOW_API_TOKEN}`, 'accept-version': '2.0.0' },
  });
  const field = (res.data.fields || []).find(f => f.slug === 'vrsta-usluge');
  const map = {};
  for (const o of field?.validations?.options || []) map[o.id] = o.name;
  return map;
}

function short(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

async function getPartnersAndCategories() {
  const now = Date.now();

  if (partnersCache && categoriesCache && cacheTime && now - cacheTime < CACHE_DURATION) {
    return { partners: partnersCache, categories: categoriesCache };
  }

  console.log('Dohvaćam partnere iz Webflow CMS-a...');

  const [partnersRaw, categoryMap] = await Promise.all([
    fetchAllItems(PARTNERS_COLLECTION_ID),
    fetchCategoryOptions(),
  ]);

  const partners = partnersRaw
    .filter(p => p.fieldData && !p.isDraft && !p.isArchived && p.fieldData.name)
    .map(p => {
      const fd = p.fieldData;
      // Paket je zapisan kao switch polja "premium" / "plus" (inače Basic)
      const tier = fd.premium ? 'Premium' : fd.plus ? 'Plus' : 'Basic';
      return {
        id: p.id,
        name: fd.name.trim(),
        category: categoryMap[fd['vrsta-usluge']] || 'Ostale usluge',
        tier,
        location: [fd.grad, fd.zupanija].map(x => (x || '').trim()).filter(Boolean).join(', '),
        // Basic partneri dobivaju kraći opis da prompt ne bude prevelik
        description: short(fd.opis || fd['popis-usluga-paragraf'], tier === 'Basic' ? 120 : 300),
        website: fd['web-stranica'] || '',
        phone: (fd.kontakt || fd['kontkat-bijeli'] || '').trim(),
        email: (fd.email || '').trim(),
        profile: fd.slug ? `https://www.the-eventer.com/partneri/${fd.slug}` : '',
      };
    });

  // Stabilan redoslijed (važno za cache promptova): paket, pa abecedno
  const tierOrder = { Premium: 0, Plus: 1, Basic: 2 };
  partners.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.name.localeCompare(b.name, 'hr'));

  partnersCache = partners;
  categoriesCache = Object.values(categoryMap);
  cacheTime = now;

  const count = t => partners.filter(p => p.tier === t).length;
  console.log(`Učitano ${partners.length} partnera (Premium ${count('Premium')}, Plus ${count('Plus')}), ${categoriesCache.length} kategorija`);
  return { partners, categories: categoriesCache };
}

const VENUE_CATEGORIES = ['Sale za vjenčanja', 'Prostori za proslave'];

function partnerLine(p) {
  let line = `- ${p.name}`;
  if (p.location) line += ` (${p.location})`;
  if (p.description) line += ` — ${p.description}`;
  const contacts = [
    p.phone && `tel: ${p.phone}`,
    p.email && `email: ${p.email}`,
    p.website && `web: ${p.website}`,
    p.profile && `profil: ${p.profile}`,
  ].filter(Boolean).join(' | ');
  if (contacts) line += ` [${contacts}]`;
  return line + '\n';
}

function buildSystemPrompt(partners, categories) {
  const featured = partners.filter(p => p.tier !== 'Basic');

  // Istaknuti (Premium/Plus) partneri — zasebno na vrhu da ih AI ne propusti
  let featuredContext = '';
  for (const tier of ['Premium', 'Plus']) {
    for (const p of featured.filter(x => x.tier === tier)) {
      featuredContext += `[${tier} · ${p.category}] ` + partnerLine(p).slice(2);
    }
  }
  if (!featuredContext) featuredContext = '(trenutno nema istaknutih partnera)\n';
  const featuredNames = featured.length
    ? featured.map(p => `${p.name} (${p.category})`).join('; ')
    : 'trenutno nitko';

  // Ostali (Basic) partneri po kategorijama
  const byCategory = {};
  for (const p of partners.filter(x => x.tier === 'Basic')) {
    (byCategory[p.category] = byCategory[p.category] || []).push(p);
  }
  // Unutar kategorije grupiraj po lokaciji (županija), da AI lakše nađe partnere u traženom kraju
  const byPlace = (a, b) => (a.location.split(', ').pop() || '~').localeCompare(b.location.split(', ').pop() || '~', 'hr') || a.name.localeCompare(b.name, 'hr');
  let basicContext = '';
  for (const cat of Object.keys(byCategory).sort((a, b) => a.localeCompare(b, 'hr'))) {
    basicContext += `\n### ${cat}\n` + byCategory[cat].sort(byPlace).map(partnerLine).join('');
  }

  // Pregled: koliko partnera ima u kojoj županiji
  const counties = {};
  for (const p of partners) {
    const c = p.location ? p.location.split(', ').pop() : 'nepoznato';
    counties[c] = (counties[c] || 0) + 1;
  }
  const countySummary = Object.entries(counties).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join(', ');

  return `Ti si Eventer AI, stručni asistent za planiranje evenata na platformi The Eventer (the-eventer.com). Pomažeš korisnicima isplanirati event koristeći ISKLJUČIVO partnere s ove platforme.

## Najvažnije pravilo: ISTAKNUTI PARTNERI IDU PRVI
Istaknuti partneri su ISKLJUČIVO ovi: ${featuredNames}.
Samo oni smiju dobiti oznaku "⭐ Preporučeni partner" — nikad je ne stavljaj nijednom drugom partneru, ma koliko dobro odgovarao.
Platforma živi od istaknutih partnera, zato:
- Kad god korisniku treba usluga iz kategorije u kojoj postoji istaknuti partner, taj partner je UVIJEK tvoj PRVI prijedlog u toj kategoriji. Premium ide prije Plusa, Plus prije ostalih.
- Označi ga s "⭐ Preporučeni partner" i u jednoj rečenici reci zašto se uklapa u korisnikov event.
- Za sale i prostore (${VENUE_CATEGORIES.join(', ')}) lokacija je bitna: istaknuti prostor predloži prvi ako je u traženom gradu/županiji ili susjednoj županiji.
- Za sve ostale usluge (booth, foto i video, glazba, torte, dekoracija, šminka, vozila…) istaknutog partnera predloži prvog čak i ako je iz druge županije — samo napiši odakle je i da korisnik provjeri dolazi li na njegovu lokaciju.
- Tek nakon istaknutog partnera dodaj 1–2 ostala partnera iz te kategorije, najbliža korisnikovoj lokaciji.
- Kad korisnik tek opisuje event, a već znaš vrstu eventa, slobodno odmah spomeni istaknute partnere koji mu odgovaraju (npr. photo booth za vjenčanje ili rođendan).
- Ako predlažeš uslugu iz kategorije istaknutog partnera (npr. photo booth, foto-zabavu, uspomene), istaknuti partner mora biti na prvom mjestu u tom dijelu odgovora.

## Ostala pravila
1. Predlažeš SAMO partnere s ovih popisa — nikad vanjske tvrtke, brendove ili servise. Ne izmišljaj partnere, cijene ni kontakte.
2. Postavljaj potpitanja postupno (2–3 odjednom) dok ne saznaš: vrstu eventa, grad/županiju, broj gostiju, datum ili period, okvirni budžet i posebne želje. Kad imaš dovoljno, daj plan.
3. Uz svakog predloženog partnera napiši:
   **Naziv partnera** — kratko zašto baš on
   📞 telefon | ✉️ email | 🌐 web | 🔗 [Profil na The Eventeru](link profila)
   Prikaži SAMO kontakte koji postoje (bez "nije dostupno"). Link na profil uvijek stavi.
4. Korisniku nikad ne pišeš riječi "Basic", "Plus" ili "Premium" — za istaknute koristiš samo "⭐ Preporučeni partner".
5. Lokacija: za ostale partnere biraj one iz korisnikovog grada/županije ili najbliže. Ako blizu nema nikoga u nekoj kategoriji, reci to kratko i predloži najbliže partnere s platforme (uz napomenu da provjere dolaze li). Nikad ne upućuj korisnika na tvrtke, hotele ili slastičarne izvan platforme.
6. Na kraju plana dodaj "📋 Sažetak kontakata" s istim redoslijedom (preporučeni partneri prvi).
7. Odgovaraj na hrvatskom, toplo i stručno, kao osobni event planer. Budi sažet — bez dugih uvoda.
8. O partneru govori samo ono što piše u njegovom opisu i kategoriji. Ne izmišljaj kapacitet, sadržaje, cijene ni udaljenosti — ako nešto nije navedeno, predloži korisniku da to provjeri kod partnera.
9. Prije nego kažeš da na nekoj lokaciji nema partnera, pogledaj pregled po županijama i cijelu kategoriju (partneri su unutar kategorije poredani po županiji). Grad Zagreb i Zagrebačka županija su susjedne.

## Broj partnera po županijama
${countySummary}

## ⭐ ISTAKNUTI PARTNERI (uvijek prvi prijedlog u svojoj kategoriji)
${featuredContext}
## Ostali partneri po kategorijama
${basicContext}

## Kategorije usluga: ${categories.join(', ')}`;
}

// Podaci se drže u memoriji i osvježavaju u pozadini — korisnik nikad ne čeka Webflow
let refreshing = null;
function refreshData() {
  if (!refreshing) {
    cacheTime = null; // prisili novi dohvat
    refreshing = getPartnersAndCategories()
      .catch(err => console.error('Greška pri dohvaćanju partnera:', err.message))
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function getData() {
  if (partnersCache && categoriesCache) {
    if (Date.now() - cacheTime > CACHE_DURATION) refreshData(); // stari podaci odmah, novi u pozadini
    return { partners: partnersCache, categories: categoriesCache };
  }
  await refreshData();
  if (!partnersCache) throw new Error('Partneri nisu dostupni');
  return { partners: partnersCache, categories: categoriesCache };
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  // Zaštita od zloupotrebe: ograniči duljinu razgovora i poruka
  const clean = messages
    .slice(-30)
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (clean.length && clean[0].role !== 'user') clean.shift();
  return clean;
}

async function buildRequest(messages) {
  const { partners, categories } = await getData();
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    // Popis partnera je velik i isti za sve korisnike -> cache (jeftinije i brži početak odgovora)
    system: [{ type: 'text', text: buildSystemPrompt(partners, categories), cache_control: { type: 'ephemeral' } }],
    messages,
  };
}

// Stara ruta (cijeli odgovor odjednom) — ostaje radi kompatibilnosti
app.post('/chat', async (req, res) => {
  try {
    const messages = cleanMessages(req.body?.messages);
    if (!messages.length) return res.status(400).json({ error: 'Neispravne poruke' });

    const response = await anthropic.messages.create(await buildRequest(messages));
    const text = response.content?.find(b => b.type === 'text')?.text || 'Nešto je pošlo po krivu. Pokušaj ponovo.';
    res.json({ message: text });
  } catch (error) {
    console.error('Greška:', error.message);
    res.status(500).json({ error: 'Interna greška servera' });
  }
});

// Nova ruta: odgovor stiže postupno, riječ po riječ (korisnik odmah vidi da AI piše)
app.post('/chat-stream', async (req, res) => {
  const messages = cleanMessages(req.body?.messages);
  if (!messages.length) return res.status(400).json({ error: 'Neispravne poruke' });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let aborted = false;
  let stream = null;
  res.on('close', () => { aborted = true; if (stream && !res.writableFinished) stream.abort(); });

  try {
    stream = anthropic.messages.stream(await buildRequest(messages));
    stream.on('text', t => { if (!aborted) res.write(t); });
    await stream.finalMessage();
  } catch (error) {
    if (!aborted) {
      console.error('Greška (stream):', error.message);
      res.write('\n\n⚠️ Nešto je pošlo po krivu. Pokušaj ponovo.');
    }
  }
  if (!aborted) res.end();
});

// Health check (frontend ga zove čim se stranica otvori da "probudi" server)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', partners: partnersCache ? partnersCache.length : 0, timestamp: new Date().toISOString() });
});

// Odmah osvježi popis partnera (npr. nakon dodavanja novog partnera)
app.post('/refresh-cache', async (req, res) => {
  await refreshData();
  res.json({ message: 'Partneri osvježeni.', partners: partnersCache ? partnersCache.length : 0 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Eventer AI backend radi na portu ${PORT}`);
  refreshData(); // učitaj partnere odmah pri pokretanju, ne tek na prvo pitanje
});
