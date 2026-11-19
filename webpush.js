'use strict';
// Web Push with no dependencies: message encryption (RFC 8291, aes128gcm per RFC 8188)
// and VAPID sign-in to the push service (RFC 8292). Uses only Node's built-in crypto and https.
const crypto = require('crypto');
const https = require('https');

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = str => Buffer.from(String(str), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ---------- keys ----------
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}
// Raw P-256 private key (32 bytes) -> KeyObject for signing
function privateKeyObject(publicKeyB64, privateKeyB64) {
  const pub = unb64u(publicKeyB64);
  return crypto.createPrivateKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', d: b64u(unb64u(privateKeyB64)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)),
  } });
}

// ---------- encryption (RFC 8291) ----------
// `_test` lets the test supply the fixed sender key and salt from the RFC example.
function encrypt(payload, subscription, _test = {}) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Bad subscription keys');

  const as = crypto.createECDH('prime256v1');
  if (_test.asPrivate) as.setPrivateKey(unb64u(_test.asPrivate)); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const salt = _test.salt ? unb64u(_test.salt) : crypto.randomBytes(16);

  const ecdhSecret = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  // one record: the plaintext, then the 0x02 "last record" delimiter
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body]);
}

// ---------- VAPID (RFC 8292) ----------
function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const jwtHeader = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject }));
  const data = `${jwtHeader}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKeyObject(vapid.publicKey, vapid.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ---------- send ----------
// Resolves { status }. 404/410 mean the subscription is gone and should be deleted.
function send(subscription, payload, vapid, { ttl = 3600, urgency = 'high', topic } = {}) {
  const body = encrypt(typeof payload === 'string' ? payload : JSON.stringify(payload), subscription);
  const url = new URL(subscription.endpoint);
  const headers = {
    'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': body.length,
    TTL: String(ttl), Urgency: urgency, Authorization: vapidHeader(subscription.endpoint, vapid),
  };
  if (topic) headers.Topic = topic;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, timeout: 10000 }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: text.slice(0, 300) }));
    });
    req.on('timeout', () => req.destroy(new Error('Push service timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { generateVapidKeys, encrypt, vapidHeader, send, b64u, unb64u };
