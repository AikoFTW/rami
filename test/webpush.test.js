// Checks the push encryption against the worked example in RFC 8291 (Section 5 / Appendix A),
// and that our VAPID signature verifies.
const assert = require('assert');
const crypto = require('crypto');
const wp = require('../webpush');
const t = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message); process.exitCode = 1; } };

const V = {   // RFC 8291 test vector
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
t('encryption matches the RFC 8291 example byte for byte', () => {
  const out = wp.encrypt(wp.unb64u(V.plaintext), { keys: { p256dh: V.uaPublic, auth: V.auth } }, { asPrivate: V.asPrivate, salt: V.salt });
  assert.equal(wp.b64u(out), V.message);
});
t('VAPID token is a valid ES256 signature for the push service origin', () => {
  const keys = wp.generateVapidKeys();
  const h = wp.vapidHeader('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'mailto:test@example.com' });
  const [, token, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [hd, cl, sig] = token.split('.');
  const claims = JSON.parse(Buffer.from(cl, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com'); assert(claims.exp > Date.now() / 1000);
  const pub = wp.unb64u(keys.publicKey);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: wp.b64u(pub.subarray(1, 33)), y: wp.b64u(pub.subarray(33)) } });
  assert(crypto.verify('sha256', Buffer.from(`${hd}.${cl}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});
