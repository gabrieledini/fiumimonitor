// Falda: freatimetro più vicino (WFS SIR) e soggiacenza giornaliera dall'archivio SIR.
// L'archivio è lento, per questo viene letto da una background function e salvato su Netlify Blobs.

export const LUOGHI = { viareggio: { nome: 'Viareggio', lat: 43.874, lon: 10.252 } };

const WFS_FREAT = 'https://geo.sir.toscana.it/geoserver/geo/ows?service=WFS&version=1.0.0&request=GetFeature'
  + '&typeName=geo%3Acf_freatimetri&maxFeatures=300000&outputFormat=application%2Fjson&srsName=EPSG%3A4326';
// CSV dell'archivio SIR: "gg/mm/aaaa";"Livello [m]";"Tipo Dato", livello rispetto al piano campagna (negativo = sotto)
const ARCHIVIO = (id) => `https://sir.toscana.it/archivio/download.php?IDST=freati&IDS=${id}`;

async function scarica(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 IdrometriToscana' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const num = (s) => { const m = String(s ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

export async function freatimetriVicini(punto, quanti = 3) {
  const feats = JSON.parse(await scarica(WFS_FREAT, 15000)).features || [];
  return feats.map((f) => {
    const p = f.properties || {};
    let g = f.geometry?.coordinates;
    while (Array.isArray(g) && Array.isArray(g[0])) g = g[0];
    if (!p.id_stazione || !Array.isArray(g)) return null;
    const pos = { lon: +g[0], lat: +g[1] };
    return { id: String(p.id_stazione).toUpperCase(), nome: p.nome || p.id_stazione, comune: p.comune || '', ...pos, km: Math.round(km(punto, pos) * 10) / 10 };
  }).filter(Boolean).sort((a, b) => a.km - b.km).slice(0, quanti);
}

// Righe "18/11/2026;-0,54;P" → { d: '2026-11-18', v: -0.54, tipo: 'P' }; i dati mancanti (@) vengono scartati
export function leggiCsv(testo) {
  const out = [];
  for (const l of String(testo).split(/\r?\n/)) {
    const m = l.trim().match(/^(\d{2})\/(\d{2})\/(\d{4});(-?\d+(?:,\d+)?);([A-Z])/);
    if (m) out.push({ d: `${m[3]}-${m[2]}-${m[1]}`, v: parseFloat(m[4].replace(',', '.')), tipo: m[5] });
  }
  return out;
}

// Lettura completa, senza fretta: pensata per la background function
export async function calcolaFalda(luogo) {
  const punto = LUOGHI[luogo];
  const vicini = await freatimetriVicini(punto);
  const prove = [];
  for (const v of vicini) {
    const url = ARCHIVIO(v.id);
    const inizio = Date.now();
    try {
      const testo = await scarica(url, 120000);
      const punti = leggiCsv(testo);
      prove.push({ url, ms: Date.now() - inizio, caratteri: testo.length, punti: punti.length, ultimo: punti.at(-1) || null });
      if (!punti.length) continue;
      const massimo = punti.reduce((a, p) => (p.v > a.v ? p : a));
      const limite = new Date(Date.parse(punti.at(-1).d) - 30 * 86400e3).toISOString().slice(0, 10);
      const serie = punti.filter((p) => p.d >= limite).map((p) => ({ t: `${p.d}T12:00:00+01:00`, v1: p.v, stato: p.tipo }));
      return {
        dati: {
          id: v.id, nome: `${v.nome}${v.comune ? ' – ' + v.comune : ''}`, km: v.km, giornaliero: true,
          tipo: 'livello', colonna: 'livello falda (m dal piano campagna)',
          massimo: { v: massimo.v, d: massimo.d }, dal: punti[0].d,
          serie,
        },
        prove, vicini,
      };
    } catch (e) {
      prove.push({ url, ms: Date.now() - inizio, errore: e.message });
    }
  }
  return { dati: null, prove, vicini };
}
