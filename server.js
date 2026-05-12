const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

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
      `https://api.webflow.com/v2/collections/${collectionId}/items`,
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

async function getPartnersAndCategories() {
  const now = Date.now();

  if (partnersCache && categoriesCache && cacheTime && now - cacheTime < CACHE_DURATION) {
    return { partners: partnersCache, categories: categoriesCache };
  }

  console.log('Dohvaćam partnere iz Webflow CMS-a...');

  const [partnersRaw, categoriesRaw] = await Promise.all([
    fetchAllItems(PARTNERS_COLLECTION_ID),
    fetchAllItems(CATEGORIES_COLLECTION_ID),
  ]);

  // Mapiraj kategorije po ID-u
  const categoryMap = {};
  for (const cat of categoriesRaw) {
    categoryMap[cat.id] = cat.fieldData?.name || cat.fieldData?.naziv || 'Ostalo';
  }

  // Procesiraj partnere
  const partners = partnersRaw
    .filter(p => p.fieldData && !p.isDraft && !p.isArchived)
    .map(p => {
      const fd = p.fieldData;

      // Pronađi tier (Premium, Plus, Basic)
      let tier = 'Basic';
      const tierField = fd['tier'] || fd['paket'] || fd['plan'] || '';
      if (typeof tierField === 'string') {
        if (tierField.toLowerCase().includes('premium')) tier = 'Premium';
        else if (tierField.toLowerCase().includes('plus')) tier = 'Plus';
      }

      // Pronađi kategoriju
      let categoryName = 'Ostalo';
      const catRef = fd['kategorija-usluge'] || fd['category'] || fd['kategorija'];
      if (catRef) {
        const catId = typeof catRef === 'object' ? catRef.id : catRef;
        categoryName = categoryMap[catId] || 'Ostalo';
      }

      return {
        id: p.id,
        name: fd['name'] || fd['naziv'] || 'Nepoznato',
        category: categoryName,
        tier,
        location: fd['lokacija'] || fd['location'] || fd['grad'] || '',
        description: fd['opis'] || fd['description'] || fd['kratki-opis'] || '',
        website: fd['website'] || fd['web'] || fd['link'] || '',
        phone: fd['telefon'] || fd['phone'] || '',
        email: fd['email'] || fd['e-mail'] || '',
        slug: p.slug || '',
      };
    });

  // Sortiraj: Premium → Plus → Basic
  partners.sort((a, b) => {
    const tierOrder = { Premium: 0, Plus: 1, Basic: 2 };
    return (tierOrder[a.tier] ?? 2) - (tierOrder[b.tier] ?? 2);
  });

  partnersCache = partners;
  categoriesCache = Object.values(categoryMap);
  cacheTime = now;

  console.log(`Učitano ${partners.length} partnera, ${categoriesCache.length} kategorija`);
  return { partners, categories: categoriesCache };
}

function buildSystemPrompt(partners, categories) {
  // Grupiraj partnere po kategoriji i tieru
  const byCategory = {};
  for (const p of partners) {
    if (!byCategory[p.category]) byCategory[p.category] = { Premium: [], Plus: [], Basic: [] };
    byCategory[p.category][p.tier].push(p);
  }

  let partnersContext = '';
  for (const [cat, tiers] of Object.entries(byCategory)) {
    partnersContext += `\n### ${cat}\n`;
    for (const tier of ['Premium', 'Plus', 'Basic']) {
      if (tiers[tier].length > 0) {
        partnersContext += `**${tier} partneri:**\n`;
        for (const p of tiers[tier]) {
          partnersContext += `- ${p.name}`;
          if (p.location) partnersContext += ` (${p.location})`;
          if (p.description) partnersContext += ` — ${p.description}`;
          if (p.website) partnersContext += ` [web: ${p.website}]`;
          partnersContext += '\n';
        }
      }
    }
  }

  return `Ti si Eventer AI, stručni asistent za planiranje evenata na platformi The Eventer. Pomažeš korisnicima isplanirati savršen event koristeći ISKLJUČIVO partnere s The Eventer platforme.

## Pravila koja UVIJEK moraš slijediti:

1. **Predlažeš SAMO partnere s ove liste** — nikad vanjskih servisa, brendova ili tvrtki koje nisu ovdje.
2. **Prioritet:** Uvijek prvo predloži **Premium** partnere, zatim **Plus**, pa tek onda **Basic** — za svaku kategoriju.
3. **Postavljaj potpitanja** — ne daj plan dok nemaš dovoljno informacija. Pitaj o:
   - Vrsti eventa (vjenčanje, rođendan, korporativni event, itd.)
   - Lokaciji / gradu
   - Broju gostiju
   - Datumu ili periodu
   - Budžetu (okvirno)
   - Posebnim zahtjevima
4. **Prikupljaj info postupno** — ne bombardiraj s previše pitanja odjednom. Postavi 2-3 ključna pitanja, pričekaj odgovor, pa nastavi.
5. **Kad predlažeš partnera, UVIJEK uz ime partnera odmah daj sve dostupne kontakte** — telefon, email i website. Format:
   - **Naziv partnera** (Premium/Plus/Basic) — kratki opis
     📞 telefon | ✉️ email | 🌐 website
   Ako neki kontakt podatak nedostaje za partnera, ne izmišljaj — preskoči samo taj podatak.
6. **Na kraju razgovora kad daš plan, uvijek dodaj sekciju "📋 Sažetak svih kontakata"** gdje sumiraš sve preporučene partnere s njihovim kontaktima u jasnoj listi koju korisnik može lako kopirati.
7. **Jezik:** Uvijek odgovaraj na hrvatskom jeziku.
8. **Ton:** Prijatan, stručan, entuzijastičan — kao osobni event planer.

## Dostupni partneri na platformi:
${partnersContext}

## Kategorije usluga: ${categories.join(', ')}

Zapamti: tvoj cilj je pomoći korisniku da organizira nevjerojatan event koristeći The Eventer partnere — i da ima sve kontakte odmah pri ruci!`;
}

// Glavna chat ruta
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Nedostaju poruke' });
    }

    const { partners, categories } = await getPartnersAndCategories();
    const systemPrompt = buildSystemPrompt(partners, categories);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages,
    });

    const assistantMessage = response.content?.[0]?.text || 'Nešto je pošlo po krivu. Pokušaj ponovo.';

    res.json({ message: assistantMessage });
  } catch (error) {
    console.error('Greška:', error.message);
    res.status(500).json({ error: 'Interna greška servera', details: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Invalidate cache (za slučaj da dodaš partnera i hoćeš odmah)
app.post('/refresh-cache', (req, res) => {
  partnersCache = null;
  categoriesCache = null;
  cacheTime = null;
  res.json({ message: 'Cache invalidiran — sljedeći chat dohvatit će svježe podatke.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Eventer AI backend radi na portu ${PORT}`);
});
