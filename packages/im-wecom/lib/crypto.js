// 企微消息加解密薄封装（官方 @wecom/crypto，AGENTS.md 规则 #2：用官方实现，不手写协议）
//
// 官方 API 形态：
//   getSignature(token, ts, nonce, msg) → sha1 签名
//   decrypt(encodingAESKey, ciphered)   → { message, id, random }
//   encrypt(encodingAESKey, msg, id)    → ciphered
// 本包装把对象解包成字符串，提供稳定导入面（便于测试注入/替换）。

import { decrypt, encrypt, getSignature } from '@wecom/crypto';

export function wecomSignature(token, timestamp, nonce, msg) {
  return getSignature(token, timestamp, nonce, msg ?? '');
}

/** 解密 → 返回明文（message 部分）。 */
export function wecomDecrypt(encodingAESKey, encrypted) {
  return decrypt(encodingAESKey, encrypted).message;
}

/** 加密（测试构造回调载荷用；id 为 receiveid，可传任意字符串）。 */
export function wecomEncrypt(encodingAESKey, msg, id = '') {
  return encrypt(encodingAESKey, msg, id);
}
