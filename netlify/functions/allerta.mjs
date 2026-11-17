// GET /.netlify/functions/allerta?comune=Viareggio        → zona, livelli oggi/domani, notifiche comunali, mappe
// GET /.netlify/functions/allerta?comune=Viareggio&raw=1  → record grezzi del GeoServer (debug)
import { allertaComune, layer } from '../lib/allerte.mjs';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' },
});

export default async (req) => {
  const u = new URL(req.url);
  const comune = (u.searchParams.get('comune') || '').trim();
  if (!comune) return json(400, { ok: false, errore: 'Parametro comune mancante' });
  try {
    if (u.searchParams.get('raw')) {
      const prova = async (nome) => { try { return (await layer(nome)).slice(0, 3); } catch (e) { return `ERRORE: ${e.message}`; } };
      return json(200, { comuni: await prova('comuni'), bollettinoOggi: await prova('bollettino_oggi'), notifiche: await prova('notifiche') });
    }
    return json(200, { ok: true, ...(await allertaComune(comune)) });
  } catch (e) {
    return json(502, { ok: false, errore: e.message });
  }
};
