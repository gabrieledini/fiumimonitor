// Allerte per comune: zona di allerta, livelli del bollettino, notifiche comunali.
// Fonte: GeoServer di Cittadino Informato (ANCI Toscana), che riprende il bollettino del CFR.
// Usato da functions/allerta.mjs (pagina) e functions/controlla-allerte.mjs (push).

const GEO = 'https://cittadinoinformato.it/geoserver/ANCI_Toscana/ows?service=WFS&version=1.0.0&request=GetFeature&outputFormat=application/json';
export const RISCHI = ['idrogeologico', 'idraulico', 'temporali', 'mareggiate'];
export const COLORI = ['verde', 'giallo', 'arancione', 'rosso'];
const PAGINA = 'https://www.regione.toscana.it/allertameteo';

export const norm = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function scarica(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 IdrometriToscana' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

export const layer = async (nome, filtro) =>
  JSON.parse(await scarica(`${GEO}&typeName=ANCI_Toscana:${nome}${filtro ? `&CQL_FILTER=${encodeURIComponent(filtro)}` : ''}`)).features || [];

// Valore del campo → colore: parole ("giallo", "Arancione - Allerta") o codici 0-3
export function colore(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = String(v).toLowerCase();
  return COLORI.find((c) => t.includes(c)) || (/^\d+$/.test(t) ? COLORI[Math.min(+t, 3)] : null);
}

// Il record contiene il nome del comune in qualche campo testuale?
const contieneComune = (props, comune) => Object.values(props || {}).some((v) => typeof v === 'string' && norm(v) === norm(comune));

let cacheComuni = null;
export async function zonaDelComune(comune) {
  cacheComuni ||= await layer('comuni');
  const f = cacheComuni.find((x) => contieneComune(x.properties, comune));
  if (!f) return null;
  const p = f.properties;
  const k = Object.keys(p).find((x) => /^(area|zona|zona_allerta|area_allerta|cod_area)$/i.test(x))
    || Object.keys(p).find((x) => /area|zona/i.test(x));
  return k ? String(p[k]).trim().toUpperCase() : null;
}

export async function livelliZona(zona, giorno) {
  const feats = await layer(`bollettino_${giorno}`, `area='${zona}'`);
  const f = feats.find((x) => String(x.properties?.area ?? '').trim().toUpperCase() === zona);
  if (!f) return null;
  return Object.fromEntries(RISCHI.map((k) => [k, { livello: colore(f.properties[k]), valore: f.properties[k] ?? null }]));
}

// Notifiche comunali attive (campi cercati per nome, perché non documentati)
export async function notificheComune(comune) {
  const feats = await layer('notifiche');
  const adesso = Date.now();
  const campo = (p, re) => { const k = Object.keys(p).find((x) => re.test(x)); return k ? p[k] : null; };
  return feats
    .map((f) => f.properties || {})
    .filter((p) => contieneComune(p, comune))
    .filter((p) => {
      const fine = Date.parse(campo(p, /^(fine|data_fine|fine_validita|end)/i) ?? '');
      return Number.isNaN(fine) || fine >= adesso;
    })
    .map((p) => ({
      id: String(campo(p, /^(id|fid|gid)$/i) ?? JSON.stringify(p).length),
      titolo: campo(p, /titolo|title|oggetto/i) || 'Comunicazione',
      testo: campo(p, /testo|messaggio|descr|body|contenuto/i) || '',
      inizio: campo(p, /^(inizio|data_inizio|start)/i),
      fine: campo(p, /^(fine|data_fine|fine_validita|end)/i),
    }));
}

export async function emissione() {
  try {
    const t = (await scarica(PAGINA)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const m = t.match(/Emissione di\s+[^,]+,\s*\d{1,2}\s+[a-zàèéìòù]+\s+\d{4},\s*ore\s+\d{1,2}[.:]\d{2}/i);
    return m ? m[0].replace(/^Emissione di\s+/i, '') : null;
  } catch (_) { return null; }
}

export function giornoItalia(offset = 0) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(Date.now() + offset * 86400000)).replace(/-/g, '');
}
export const mappe = (stamp) => Object.fromEntries(RISCHI.map((k) => [k, `https://www.sir.toscana.it/supports/images/risks_395/${stamp}_${k}.png`]));

// Quadro completo per un comune
export async function allertaComune(comune) {
  const zona = await zonaDelComune(comune).catch(() => null);
  const prendi = (g) => (zona ? livelliZona(zona, g).catch((e) => ({ errore: e.message })) : Promise.resolve(null));
  const [lo, ld, notifiche, em] = await Promise.all([
    prendi('oggi'), prendi('domani'),
    notificheComune(comune).catch(() => []),
    emissione(),
  ]);
  const giorno = (l, off) => ({ livelli: l?.errore ? null : l, errore: l?.errore || (zona ? null : 'zona di allerta non trovata'), mappe: mappe(giornoItalia(off)) });
  return { comune, zona, emissione: em, oggi: giorno(lo, 0), domani: giorno(ld, 1), notifiche };
}

// Livello più alto tra i rischi di un giorno
export const massimo = (livelli) => Object.values(livelli || {}).map((x) => x.livello).filter(Boolean)
  .sort((a, b) => COLORI.indexOf(b) - COLORI.indexOf(a))[0] || null;
