import fs from 'node:fs';
const { parseBytesRepr } = await import('../js/serial.js');
const { reprs, hex } = JSON.parse(fs.readFileSync(process.env.REPRS || '/tmp/reprs.json','utf8'));
let bad = 0, firstBad = [];
for (let i=0;i<reprs.length;i++) {
  let got;
  try { got = parseBytesRepr(reprs[i]); }
  catch (e) { bad++; if(firstBad.length<6) firstBad.push([i, reprs[i].slice(0,50), 'THREW: '+e.message]); continue; }
  const gotHex = Buffer.from(got).toString('hex');
  if (gotHex !== hex[i]) { bad++; if(firstBad.length<6) firstBad.push([i, reprs[i].slice(0,50), `want ${hex[i].slice(0,30)} got ${gotHex.slice(0,30)}`]); }
}
console.log(`parseBytesRepr on real Python repr(): ${reprs.length-bad}/${reprs.length} exact`);
for (const f of firstBad) console.log('  case', f[0], JSON.stringify(f[1]), '->', f[2]);
