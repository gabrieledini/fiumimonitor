// Iscrizioni alle notifiche push per comune
// GET  /.netlify/functions/push                         → chiave pubblica VAPID
// POST /.netlify/functions/push {azione:'iscrivi', subscription, comune}
// POST /.netlify/functions/push {azione:'annulla', subscription}
// POST /.netlify/functions/push {azione:'prova', subscription}  → notifica di prova
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { createHash } from 'node:crypto';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const chiave = (endpoint) => createHash('sha256').update(endpoint).digest('hex');

export default async (req) => {
  // Le variabili si leggono sia da Netlify.env (functions v2) sia da process.env
  const env = (k) => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? '').trim();
  const VAPID_PUBLIC_KEY = env('VAPID_PUBLIC_KEY'), VAPID_PRIVATE_KEY = env('VAPID_PRIVATE_KEY'), VAPID_SUBJECT = env('VAPID_SUBJECT');
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    const mancanti = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'].filter((k) => !env(k));
    const simili = Object.keys(process.env).filter((k) => /vapid/i.test(k));
    return json(500, { errore: 'Chiavi VAPID non configurate su Netlify', mancanti, variabiliSimiliTrovate: simili, contesto: process.env.CONTEXT || null });
  }
  if (req.method === 'GET') return json(200, { publicKey: VAPID_PUBLIC_KEY });
  if (req.method !== 'POST') return json(405, { errore: 'Metodo non ammesso' });

  const body = await req.json().catch(() => ({}));
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(400, { errore: 'Iscrizione push non valida' });
  const store = getStore('push-iscrizioni');
  const k = chiave(sub.endpoint);

  if (body.azione === 'iscrivi') {
    const comune = String(body.comune || '').trim();
    if (!comune) return json(400, { errore: 'Comune mancante' });
    await store.setJSON(k, { subscription: sub, comune, creato: new Date().toISOString() });
    return json(200, { ok: true, comune });
  }
  if (body.azione === 'annulla') {
    await store.delete(k);
    return json(200, { ok: true });
  }
  if (body.azione === 'prova') {
    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const iscr = await store.get(k, { type: 'json' });
    try {
      await webpush.sendNotification(sub, JSON.stringify({
        title: 'Notifica di prova',
        body: iscr ? `Riceverai le allerte per ${iscr.comune}.` : 'Le notifiche funzionano.',
        url: iscr ? `/?comune=${encodeURIComponent(iscr.comune)}` : '/',
      }));
      return json(200, { ok: true });
    } catch (e) {
      return json(502, { errore: `Invio fallito: ${e.statusCode || ''} ${e.body || e.message}` });
    }
  }
  return json(400, { errore: 'Azione sconosciuta' });
};
