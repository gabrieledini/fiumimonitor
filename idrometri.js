// Proxy CFR/SIR Toscana → JSON
// GET /.netlify/functions/idrometri                 → elenco stazioni idrometriche con località (leggero)
// GET /.netlify/functions/idrometri?ids=TOS..,TOS.. → dati attuali + serie delle stazioni richieste (solo quelle con dati)
// GET /.netlify/functions/idrometri?raw=1           → righe grezze della tabella CFR (debug)

const HOSTS = ['https://www.cfr.toscana.it', 'https://www.sir.toscana.it'];
const UA = 'Mozilla/5.0 (compatible; IdrometriToscana/1.0)';
const DATA_RE = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})[.:](\d{2})/;
const DATA_TAB_RE = /^\d{2}\/\d{2}(\/\d{4})?\s+\d{2}[.:]\d{2}$/;

async function getText(path) {
  let lastErr;
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(host + path, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`${host}${path}: HTTP ${res.status}`);
      return { host, text: await res.text() };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const clean = (s) =>
  String(s ?? '')
    .replace(/\\"/g, '"')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();

function num(s) {
  const m = String(s ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function parseArrays(html) {
  const out = [];
  const re = /new\s+Array\s*\(([\s\S]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(html))) {
    const args = [...m[1].matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)].map((a) => clean(a[1] ?? a[2]));
    if (args.length) out.push(args);
  }
  return out;
}

// "10/11/2026 03.10" (ora solare) → ISO con offset +01:00
function toISO(s) {
  const m = String(s).match(DATA_RE);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+01:00` : null;
}

// "Viareggio 1 (GPRS)" → "Viareggio"
const localitaDi = (stazione) =>
  stazione.replace(/\([^)]*\)/g, ' ').replace(/\s+\d+\s*$/, '').replace(/\s+/g, ' ').trim();

function parseTabella(html) {
  return parseArrays(html)
    .filter((a) => /^TOS\d+$/i.test(a[0]) && a.length >= 6)
    .map((a) => {
      const [id, fiume, stazione, prov, zona] = a;
      const dateIdx = a.findLastIndex((v, i) => i > 4 && DATA_TAB_RE.test(v));
      const vals = a.slice(5, dateIdx > 0 ? dateIdx : undefined);
      // Ordine colonne tabella CFR: liv.2, liv.1, livello, portata, Δh1, Δh3, Δh6
      const pos = vals.length === 7;
      return {
        id: id.toUpperCase(), fiume, stazione, prov: prov.toUpperCase(), zona,
        liv2: pos ? num(vals[0]) : null,
        liv1: pos ? num(vals[1]) : null,
        livello: pos ? num(vals[2]) : null,
        portata: pos ? num(vals[3]) : null,
        dh1: pos ? num(vals[4]) : null,
        dh3: pos ? num(vals[5]) : null,
        dh6: pos ? num(vals[6]) : null,
        _raw: a,
      };
    });
}

function parseSerie(html) {
  return parseArrays(html)
    .filter((a) => a.length >= 3 && DATA_RE.test(a[1]))
    .map((a) => ({ t: toISO(a[1]), l: num(a[2]), q: a.length > 3 ? num(a[3]) : null }))
    .filter((p) => p.t && p.l !== null)
    .sort((x, y) => x.t.localeCompare(y.t));
}

const json = (status, body, cache = 'no-store') => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    const { host, text } = await getText('/monitoraggio/stazioni.php?type=idro');
    const tabella = parseTabella(text);

    if (q.raw) return json(200, { host, righe: tabella.slice(0, 20).map((s) => s._raw) });

    // Elenco località
    if (!q.ids) {
      const stazioni = tabella.map((s) => ({
        id: s.id, fiume: s.fiume, stazione: s.stazione, prov: s.prov, localita: localitaDi(s.stazione),
      }));
      return json(200, { fonte: host, stazioni }, 'public, max-age=3600');
    }

    // Dati delle stazioni richieste
    const ids = [...new Set(q.ids.split(',').map((x) => x.trim().toUpperCase()))].filter((x) => /^TOS\d+$/.test(x)).slice(0, 20);
    const righe = ids.map((id) => tabella.find((s) => s.id === id)).filter(Boolean);

    const stazioni = (await Promise.all(
      righe.map(async (s) => {
        let serie = [];
        try {
          const det = await getText(`/monitoraggio/dettaglio.php?id=${s.id}&type=idro&${Date.now()}`);
          serie = parseSerie(det.text);
        } catch (_) { /* serie non disponibile */ }
        const ultimo = serie.at(-1);
        const { _raw, ...rest } = s;
        return {
          ...rest,
          localita: localitaDi(s.stazione),
          livello: ultimo ? ultimo.l : s.livello,
          portata: ultimo && ultimo.q !== null ? ultimo.q : s.portata,
          data: ultimo ? ultimo.t : null,
          serie,
        };
      })
    )).filter((s) => s.livello !== null);

    return json(200, { aggiornato: new Date().toISOString(), fonte: host, stazioni });
  } catch (e) {
    return json(502, { errore: `Impossibile leggere i dati CFR: ${e.message}` });
  }
};
