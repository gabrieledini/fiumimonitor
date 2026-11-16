// Genera localita.json dall'elenco stazioni idrometriche CFR Toscana.
// Uso: node scripts/genera-localita.js
const fs = require('fs');
const path = require('path');
const { getText, parseTabella, localitaDi } = require('../netlify/functions/idrometri.js');

(async () => {
  const { host, text } = await getText('/monitoraggio/stazioni.php?type=idro');
  const stazioni = parseTabella(text)
    .map((s) => ({ id: s.id, fiume: s.fiume, stazione: s.stazione, prov: s.prov, localita: localitaDi(s.stazione) }))
    .sort((a, b) => a.prov.localeCompare(b.prov) || a.localita.localeCompare(b.localita, 'it') || a.id.localeCompare(b.id));

  // Non sovrascrivere il file buono con una lettura fallita o parziale
  if (stazioni.length < 50) {
    console.error(`Solo ${stazioni.length} stazioni lette da ${host}: file non aggiornato.`);
    process.exit(1);
  }

  const out = { generato: new Date().toISOString(), fonte: host, stazioni };
  fs.writeFileSync(path.join(__dirname, '..', 'localita.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`localita.json: ${stazioni.length} stazioni, ${new Set(stazioni.map((s) => s.prov + s.localita)).size} località`);
})().catch((e) => { console.error(e); process.exit(1); });
