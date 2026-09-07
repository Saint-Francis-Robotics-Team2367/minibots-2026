const { bytesLiteral, parseBytesRepr } = await import('../js/serial.js');
const cases = [];
for (let i=0;i<256;i++) cases.push(new Uint8Array([i]));
cases.push(new Uint8Array(256).map((_,i)=>i));
cases.push(new TextEncoder().encode("print('hello')\n"));
cases.push(new TextEncoder().encode('a"b\\c\'d\n\r\t\0e'));
cases.push(new TextEncoder().encode("config = MinibotConfig('MiniBot1')\n"));
cases.push(new TextEncoder().encode("# ünïcödé — em dash ± ✓\n"));
cases.push(new Uint8Array(0));
console.log(JSON.stringify(cases.map(c => ({
  hex: Buffer.from(c).toString('hex'), lit: bytesLiteral(c),
}))));
