/** 加密系数 */
const COEFFICIENT = 0xa5;

/**
 * 与后端 encodeData 对应的编码实现。
 * JSON.stringify → encodeURIComponent → 逐字符异或 0xa5 → base64。
 */
export function encodeData(data) {
  const str = encodeURIComponent(JSON.stringify(data));
  const byteArray = new Uint8Array(str.length);

  for (let i = 0; i < str.length; i++) {
    byteArray[i] = str.charCodeAt(i) ^ COEFFICIENT;
  }

  return btoa(String.fromCharCode.apply(null, Array.from(byteArray)));
}

/**
 * encodeData 的逆运算：base64 → 逐字符异或 0xa5 → decodeURIComponent → JSON.parse。
 * 异或是自逆运算，所以解密用的还是同一个系数。
 */
export function decodeData(encoded) {
  const binary = atob(encoded);
  let str = "";

  for (let i = 0; i < binary.length; i++) {
    str += String.fromCharCode(binary.charCodeAt(i) ^ COEFFICIENT);
  }

  return JSON.parse(decodeURIComponent(str));
}
