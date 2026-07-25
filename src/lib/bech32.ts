/** 最小 bech32 编码：把 EVM 0x 地址转为 Injective 原生地址（同一套公钥字节，inj1...）。 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

/** inj1... → 0x（同一 20 字节账户，用于 Injective EVM 原生转账） */
export function injToEth(injAddress: string): string {
  const addr = injAddress.trim().toLowerCase();
  if (!addr.startsWith('inj1')) throw new Error('bad inj address');
  const data = addr.slice(4, -6); // 去掉 hrp 'inj1' 前缀与 6 位校验和
  const words = [...data].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error('bad bech32 char');
    return i;
  });
  const bytes = convertBits(words, 5, 8);
  // convertBits 5→8 会在末尾产生一个填充位，取前 20 字节
  const hex = bytes
    .slice(0, 20)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return '0x' + hex;
}

export function ethToInj(ethAddress: string): string {
  const hex = ethAddress.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('bad eth address');
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const data = convertBits(bytes, 8, 5);
  const values = [...hrpExpand('inj'), ...data];
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return 'inj1' + [...data, ...checksum].map((d) => CHARSET[d]).join('');
}
