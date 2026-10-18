function integer(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Expected a nonnegative safe integer");
  return BigInt(value);
}
function safe(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Money exceeds safe integer range");
  return result;
}
export function roundedRatio(value: number, numerator: number, denominator: number) {
  const a = integer(value), b = integer(numerator), d = integer(denominator);
  if (!d) throw new Error("Zero denominator");
  return safe((a * b * 2n + d) / (d * 2n));
}
export function allocateMinor(total: number, weights: number[]): number[] {
  const amount = integer(total), parts = weights.map(integer), sum = parts.reduce((a,b)=>a+b,0n);
  if (!sum) { if (amount) throw new Error("Cannot allocate without weights"); return weights.map(()=>0); }
  const result = parts.map(w=>amount*w/sum);
  let remaining = amount - result.reduce((a,b)=>a+b,0n);
  const order = parts.map((w,i)=>({i,r:amount*w%sum})).sort((a,b)=>a.r===b.r?a.i-b.i:a.r>b.r?-1:1);
  for (const {i} of order) { if (!remaining) break; result[i]++; remaining--; }
  return result.map(safe);
}
export function commissionMinor(price: number, discount: number, materials: number, rateBps: number) {
  [price,discount,materials,rateBps].forEach(integer);
  if (rateBps>10000) throw new Error("Invalid commission rate");
  return roundedRatio(Math.max(0,price-discount-materials),rateBps,10000);
}
export function certificateRelease(balance: number, liability: number, redeemed: number) {
  [balance,liability,redeemed].forEach(integer);
  if (redeemed>balance) throw new Error("Certificate balance exceeded");
  return redeemed===balance?liability:roundedRatio(liability,redeemed,balance);
}
export function payrollTotal(fixed: number, variable: number, guarantee: number, scope: "total" | "variable") {
  [fixed,variable,guarantee].forEach(integer);
  return safe(scope==="total" ? (BigInt(fixed)+BigInt(variable)>BigInt(guarantee)?BigInt(fixed)+BigInt(variable):BigInt(guarantee)) : BigInt(fixed)+BigInt(Math.max(variable,guarantee)));
}
