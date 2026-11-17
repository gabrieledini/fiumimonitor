// Controllo periodico delle allerte per i comuni con iscritti, e invio push se qualcosa cambia.
// Gira ogni 30 minuti come scheduled function di Netlify.
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { allertaComune, massimo, norm, RISCHI } from '../lib/allerte.mjs';

const NOMI = { idrogeologico: 'idrogeologico', idraulico: 'idraulico', temporali: 'temporali', mareggiate: 'mareggiate' };

function riepilogo(livelli) {
  return RISCHI.filter((k) => livelli?.[k]?.livello && livelli[k].livello !== 'verde')
    .map((k) => `${livelli[k].livello} ${NOMI[k]}`).join(', ');
}

export default async () => {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) { console.error('Chiavi VAPID mancanti'); return; }
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const iscrizioni = getStore('push-iscrizioni');
  const stati = getStore('push-stato');
  const { blobs } = await iscrizioni.list();
  const perComune = new Map();
  for (const b of blobs) {
    const v = await iscrizioni.get(b.key, { type: 'json' });
    if (!v?.comune) continue;
    if (!perComune.has(v.comune)) perComune.set(v.comune, []);
    perComune.get(v.comune).push({ key: b.key, ...v });
  }
  console.log(`Iscrizioni: ${blobs.length}, comuni: ${perComune.size}`);

  for (const [comune, lista] of perComune) {
    let a;
    try { a = await allertaComune(comune); } catch (e) { console.warn(`${comune}: ${e.message}`); continue; }
    const maxOggi = massimo(a.oggi.livelli), maxDomani = massimo(a.domani.livelli);
    const firma = JSON.stringify({ o: a.oggi.livelli, d: a.domani.livelli, n: a.notifiche.map((x) => x.id).sort() });
    const kStato = norm(comune);
    const prima = await stati.get(kStato, { type: 'json' });
    if (prima?.firma === firma) continue;

    const attivaOra = [maxOggi, maxDomani].some((x) => x && x !== 'verde');
    const nuoveNotifiche = a.notifiche.filter((x) => !(prima?.notifiche || []).includes(x.id));
    const finita = prima?.attiva && !attivaOra;
    await stati.setJSON(kStato, { firma, attiva: attivaOra, notifiche: a.notifiche.map((x) => x.id), aggiornato: new Date().toISOString() });
    if (!prima && !attivaOra && !nuoveNotifiche.length) continue; // primo controllo senza allerte: niente push

    const messaggi = [];
    if (attivaOra) {
      const ro = riepilogo(a.oggi.livelli), rd = riepilogo(a.domani.livelli);
      messaggi.push({
        title: `Allerta ${maxOggi && maxOggi !== 'verde' ? maxOggi : maxDomani} – ${comune}`,
        body: [ro && `Oggi: ${ro}.`, rd && `Domani: ${rd}.`].filter(Boolean).join(' ') + ` Zona ${a.zona}.`,
      });
    } else if (finita) {
      messaggi.push({ title: `Allerta terminata – ${comune}`, body: 'Il bollettino non riporta più allerte per oggi e domani.' });
    }
    for (const n of nuoveNotifiche) messaggi.push({ title: `${comune}: ${n.titolo}`, body: String(n.testo).slice(0, 180) });

    for (const m of messaggi) {
      for (const s of lista) {
        try {
          await webpush.sendNotification(s.subscription, JSON.stringify({ ...m, url: `/?comune=${encodeURIComponent(comune)}` }));
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) await iscrizioni.delete(s.key); // iscrizione scaduta
          else console.warn(`Push ${comune}: ${e.statusCode || e.message}`);
        }
      }
    }
    console.log(`${comune}: inviati ${messaggi.length} messaggi a ${lista.length} iscritti`);
  }
};

export const config = { schedule: '*/30 * * * *' };
