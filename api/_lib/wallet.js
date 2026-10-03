// Shared wallet helpers for the API: recover the signer of a personal_sign message, and short HMAC session tokens.
import { createHmac } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const hexToBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ""), "hex"));
export function recoverSigner(msg, sigHex) {
  const sig = hexToBytes(sigHex); if (sig.length !== 65) throw new Error("bad signature");
  const m = Buffer.from(msg, "utf8"), digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m]));
  let v = sig[64]; if (v >= 27) v -= 27; if (v > 1) throw new Error("bad signature");
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
  return "0x" + Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString("hex");
}
export const isAddress = (a) => /^0x[a-f0-9]{40}$/.test(String(a || "").toLowerCase());

// token = wallet.expiry.mac, signed with a server-only secret; nothing about the session is stored
export function makeToken(wallet, secret, ttlMs = 7 * 86400e3) {
  const exp = Date.now() + ttlMs, body = `${wallet.toLowerCase()}.${exp}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("hex").slice(0, 40)}`;
}
export function readToken(token, secret) {
  const [wallet, exp, mac] = String(token || "").split(".");
  if (!isAddress(wallet) || !mac || Number(exp) < Date.now()) return null;
  const want = createHmac("sha256", secret).update(`${wallet}.${exp}`).digest("hex").slice(0, 40);
  return want === mac ? wallet : null;
}
