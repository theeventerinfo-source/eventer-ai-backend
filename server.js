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
const CACHE_DURATION = 10 * 60 * 1000;

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

  console.log('Dohvacam partnere iz Webflow CMS-a...');

  const [partnersRaw, categoriesRaw] = await Promise.all([
    fetchAllItems(PARTNERS_COLLECTION_ID),
    fetchAllItems(CATEGORIES_COLLECTION_ID),
  ]);

  const categoryMap = {};
  for (const cat of categoriesRaw) {
    categoryMap[cat.id] = cat.fieldData?.name || cat.fieldData?.naziv || 'Ostalo';
  }

  const partners = partnersRaw
    .filter(p => p.fieldData && !p.isDraft && !p.isArchived)
    .map(p => {
      const fd = p.fieldData;

      let tier = 'Basic';
      const tierField = fd['tier'] || fd['paket'] || fd['plan'] || '';
      if (typeof tierField === 'string') {
        if (tierField.toLowerCase().includes('premium')) tier = 'Premium';
        else if (tierField.toLowerCase().includes('plus')) tier = 'Plus';
      }

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

  partners.sort((a, b) => {
    const tierOrder = { Premium: 0, Plus: 1, Basic: 2 };
    return (tierOrder[a.tier] ?? 2) - (tierOrder[b.tier] ?? 2);
  });

  partnersCache = partners;
  categoriesCache = Object.values(categoryMap);
  cacheTime = now;

  console.log(`Ucitano ${partners.length} partnera, ${categoriesCache.length} kategorija`);
  return { partners, categories: categoriesCache };
}

function buildSystemPrompt(partners, categories) {
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
          if (p.description) partnersContext += ` - ${p.description}`;
          if (p.website) partnersContext += ` [web: ${p.website}]`;
          partnersContext += '\n';
        }
      }
    }
  }

  return `Ti si Eventer AI, strucni asistent za planiranje evenata na platformi The Eventer. Pomazes korisnicima isplanirati savrsen event koristeci ISKLJUCIVO partnere s The Eventer platforme.

## Pravila koja UVIJEK moras slijediti:

1. **Predlazes SAMO partnere s ove liste** - nikad vanjskih servisa, brendova ili tvrtki koje nisu ovdje.
2. **Prioritet:** Uvijek prvo predlozi **Premium** partnere, zatim **Plus**, pa tek onda **Basic** - za svaku kategoriju.
3. **Postavljaj potpitanja** - ne daj plan dok nemas dovoljno informacija. Pitaj o:
   - Vrsti eventa (vjencanje, rodjendan, korporativni event, itd.)
   - Lokaciji / gradu
   - Broju gostiju
   - Datumu ili periodu
   - Budzetu (okvirno)
   - Posebnim zahtjevima
4. **Prikupljaj info postupno** - ne bombardiraj s previse pitanja odjednom. Postavi 2-3 kljucna pitanja, pricekaj odgovor, pa nastavi.
5. **Na kraju generiraj strukturirani plan** s konkretnim partnerima, okvirnim cijenama ako imas info, i sljedecim koracima.
6. **Jezik:** Uvijek odgovaraj na hrvatskom jeziku.
7. **Ton:** Prijatan, strucan, entuzijasticnan - kao osobni event planer.

## Dostupni partneri na platformi:
${partnersContext}

## Kategorije usluga: ${categories.join(', ')}

Zapamti: tvoj cilj je pomoci korisniku da organizira nevjerojatan event koristeci The Eventer partnere!`;
}

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

    const assistantMessage = response.content?.[0]?.text || 'Nesto je poslo po krivu. Pokusaj ponovo.';

    res.json({ message: assistantMessage });
  } catch (error) {
    console.error('Greska:', error.message);
    res.status(500).json({ error: 'Interna greska servera', details: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/refresh-cache', (req, res) => {
  partnersCache = null;
  categoriesCache = null;
  cacheTime = null;
  res.json({ message: 'Cache invalidiran.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Eventer AI backend radi na portu ${PORT}`);
});
