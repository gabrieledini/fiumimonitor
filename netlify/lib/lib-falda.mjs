// Falda: freatimetro più vicino a un punto (WFS SIR) e livello giornaliero dall'archivio SIR.
// L'archivio è lento, per questo viene letto da una background function e salvato su Netlify Blobs.

const WFS_FREAT = 'https://geo.sir.toscana.it/geoserver/geo/ows?service=WFS&version=1.0.0&request=GetFeature'
  + '&typeName=geo%3Acf_freatimetri&maxFeatures=300000&outputFormat=application%2Fjson&srsName=EPSG%3A4326';
// CSV: "gg/mm/aaaa";"Livello [m]";"Tipo Dato", livello rispetto al piano campagna (negativo = sotto)
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

export const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 10) / 10;
};

// Elenco di tutti i freatimetri con quota del terreno (m s.l.m.)
export async function elencoFreatimetri() {
  const feats = JSON.parse(await scarica(WFS_FREAT, 8000)).features || [];
  return feats.map((f) => {
    const p = f.properties || {};
    let g = f.geometry?.coordinates;
    while (Array.isArray(g) && Array.isArray(g[0])) g = g[0];
    if (!p.id_stazione || !Array.isArray(g)) return null;
    return {
      id: String(p.id_stazione).toUpperCase(), nome: p.nome || p.id_stazione, comune: p.comune || '',
      provincia: p.provincia || '', quota: typeof p.quota === 'number' ? p.quota : null, lon: +g[0], lat: +g[1],
    };
  }).filter(Boolean);
}

// Righe "18/11/2026;-0,54;P" → { d, v, tipo }; i dati mancanti (@) vengono scartati
export function leggiCsv(testo) {
  const out = [];
  for (const l of String(testo).split(/\r?\n/)) {
    const m = l.trim().match(/^(\d{2})\/(\d{2})\/(\d{4});(-?\d+(?:,\d+)?);([A-Z])/);
    if (m) out.push({ d: `${m[3]}-${m[2]}-${m[1]}`, v: parseFloat(m[4].replace(',', '.')), tipo: m[5] });
  }
  return out;
}

// Dati di un freatimetro: ultimi 30 giorni e massimo storico
export async function datiFreatimetro(st) {
  const url = ARCHIVIO(st.id);
  const inizio = Date.now();
  const testo = await scarica(url, 120000);
  const punti = leggiCsv(testo);
  const prova = { url, ms: Date.now() - inizio, caratteri: testo.length, punti: punti.length, ultimo: punti.at(-1) || null };
  if (!punti.length) return { dati: null, prova };
  const massimo = punti.reduce((a, p) => (p.v > a.v ? p : a));
  const limite = new Date(Date.parse(punti.at(-1).d) - 30 * 86400e3).toISOString().slice(0, 10);
  return {
    prova,
    dati: {
      id: st.id, nome: `${st.nome}${st.comune ? ' – ' + st.comune : ''}`, quota: st.quota,
      giornaliero: true, tipo: 'livello', colonna: 'livello falda (m dal piano campagna)',
      massimo: { v: massimo.v, d: massimo.d }, dal: punti[0].d,
      serie: punti.filter((p) => p.d >= limite).map((p) => ({ t: `${p.d}T12:00:00+01:00`, v1: p.v, stato: p.tipo })),
    },
  };
}
