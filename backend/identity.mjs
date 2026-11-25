/**
 * Portable OIDC authorization-code flow for Node and Workers.
 * save(key, record) stores a record privately. consume(key) removes and returns it
 * atomically. Both may be asynchronous. The browser receives only opaque values.
 */
const PROVIDERS = Object.freeze({
  google: {
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
  },
  telegram: {
    authorization: 'https://oauth.telegram.org/auth',
    token: 'https://oauth.telegram.org/token',
    jwks: 'https://oauth.telegram.org/.well-known/jwks.json',
    issuers: ['https://oauth.telegram.org'],
    scope: 'openid profile',
  },
});
const enc = new TextEncoder();
const flowLifetime = 600;
const currentTime = () => Math.floor(Date.now() / 1000);
const asBytes = value => Uint8Array.from(value, ch => ch.charCodeAt(0));
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const digest = async text => base64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));

function fail(message = 'Проверка входа не пройдена. Начните вход заново.', status = 401) {
  throw Object.assign(new Error(message), { status });
}
function appOrigin(env) {
  try {
    const url = new URL(env.PUBLIC_ORIGIN);
    const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return url.username || url.password || url.search || url.hash || url.pathname !== '/' ? null : url.origin;
  } catch { return null; }
}
function options(provider, env) {
  if (!Object.hasOwn(PROVIDERS, provider)) fail('Такой способ входа не найден.', 404);
  const prefix = provider.toUpperCase();
  const id = env[prefix + '_CLIENT_ID'];
  const secret = env[prefix + '_CLIENT_SECRET'];
  const origin = appOrigin(env);
  if (!origin || !id || !secret) fail('Этот способ входа ещё не настроен.', 503);
  const path = '/api/auth/' + provider + '/callback';
  return { ...PROVIDERS[provider], id: String(id), secret, origin, path, redirect: origin + path };
}
export function identityProviders(env) {
  const origin = appOrigin(env);
  return Object.fromEntries(Object.keys(PROVIDERS).map(provider => {
    const prefix = provider.toUpperCase();
    return [provider, Boolean(origin && env[prefix+'_CLIENT_ID'] && env[prefix+'_CLIENT_SECRET'])];
  }));
}
function cookieName(state) { return 'ob_flow_' + state.slice(0, 20); }
function cookie(cfg, state, value, age) {
  return cookieName(state) + '=' + value + '; Path=' + cfg.path +
    '; HttpOnly; SameSite=Lax; Max-Age=' + age + (cfg.origin.startsWith('https:') ? '; Secure' : '');
}
function readCookie(request, state) {
  const name = cookieName(state) + '=';
  return (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(name))?.slice(name.length);
}
const validOpaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const stateKey = (provider, state, binding) => digest([provider,state,binding].join('.'));

export async function beginIdentity(provider, env, save) {
  const cfg = options(provider, env);
  const state = randomToken(), binding = randomToken(), nonce = randomToken(), verifier = randomToken();
  const record = { provider, nonce, verifier, expires: currentTime() + flowLifetime };
  await save(await stateKey(provider, state, binding), record);
  const url = new URL(cfg.authorization);
  url.search = new URLSearchParams({
    response_type:'code', client_id:cfg.id, redirect_uri:cfg.redirect, scope:cfg.scope,
    code_challenge_method:'S256', code_challenge:await digest(verifier), state, nonce,
  }).toString();
  return { url:url.href, cookie:cookie(cfg,state,binding,flowLifetime) };
}
function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) fail();
  return asBytes(atob(part.replaceAll('-','+').replaceAll('_','/')));
}
async function fetchJson(url, init, transport) {
  try {
    const response = await transport(url, { ...init, redirect:'error', signal:AbortSignal.timeout(12000) });
    if (response.ok) return await response.json();
    if (response.status < 500) fail();
  } catch (error) {
    if (error?.status === 401) throw error;
  }
  fail('Сервис авторизации временно недоступен. Повторите вход позже.', 503);
}
async function checkToken(token, cfg, record, transport) {
  if (typeof token !== 'string' || token.length > 32768) fail();
  const parts = token.split('.');
  if (parts.length !== 3) fail();
  let header, claims, signature;
  try {
    const decoder = new TextDecoder('utf-8', {fatal:true});
    header = JSON.parse(decoder.decode(decode(parts[0])));
    claims = JSON.parse(decoder.decode(decode(parts[1])));
    signature = decode(parts[2]);
  } catch { fail(); }
  if (header?.alg !== 'RS256' || !header.kid || typeof header.kid !== 'string' || header.crit) fail();
  const keyset = await fetchJson(cfg.jwks, { headers:{Accept:'application/json'} }, transport);
  const key = Array.isArray(keyset?.keys) && keyset.keys.find(k => k.kid === header.kid && k.kty === 'RSA' &&
    (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (!key) fail();
  try {
    const publicKey = await crypto.subtle.importKey('jwk', key, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['verify']);
    const verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, enc.encode(parts.slice(0,2).join('.')));
    if (!verified) fail();
  } catch { fail(); }
  const now = currentTime();
  if (!claims || !cfg.issuers.includes(claims.iss) || claims.nonce !== record.nonce ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 ||
      claims.exp <= claims.iat || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 60)) ||
      typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 255) fail();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.id) || (aud.length > 1 && claims.azp !== cfg.id) ||
      (claims.azp !== undefined && claims.azp !== cfg.id)) fail();
  return claims;
}

export async function finishIdentity(provider, env, request, consume, transport = fetch) {
  const cfg = options(provider, env);
  const callback = new URL(request.url);
  if (callback.origin !== cfg.origin || callback.pathname !== cfg.path || request.method !== 'GET') fail();
  const params = callback.searchParams;
  const state = params.get('state');
  if (params.getAll('state').length !== 1 || !validOpaque(state)) fail();
  const binding = readCookie(request,state);
  if (!validOpaque(binding)) fail();
  const record = await consume(await stateKey(provider,state,binding));
  if (!record || record.provider !== provider || !Number.isSafeInteger(record.expires) || record.expires <= currentTime() ||
      !validOpaque(record.nonce) || !validOpaque(record.verifier)) fail();
  if (params.has('error')) fail('Вход отменён или отклонён. Можно попробовать снова.');
  const code = params.get('code');
  if (params.getAll('code').length !== 1 || !code || code.length > 4096) fail();
  if (params.has('iss') && !cfg.issuers.includes(params.get('iss'))) fail();
  const body = new URLSearchParams({
    grant_type:'authorization_code', code, redirect_uri:cfg.redirect, client_id:cfg.id, code_verifier:record.verifier,
  });
  const headers = { 'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json' };
  if (provider === 'telegram') headers.Authorization = 'Basic '+btoa(cfg.id+':'+cfg.secret);
  else body.set('client_secret',cfg.secret);
  const tokens = await fetchJson(cfg.token, { method:'POST', headers, body }, transport);
  const claims = await checkToken(tokens?.id_token, cfg, record, transport);
  return {
    provider, subject:claims.sub,
    email:provider === 'google' && claims.email_verified === true && typeof claims.email === 'string' ? claims.email.slice(0,254) : null,
    name:typeof claims.name === 'string' ? claims.name.slice(0,150) : '',
    cookie:cookie(cfg,state,'',0),
  };
}
