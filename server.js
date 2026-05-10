/**
 * IAcolmado â Servidor Webhook para GREEN-API
 * Recibe mensajes de WhatsApp y los guarda en Firestore (colmado-ia)
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const CONFIG = {
  GREEN_INSTANCE_ID: process.env.GREEN_INSTANCE_ID || 'TU_INSTANCE_ID',
  GREEN_TOKEN: process.env.GREEN_TOKEN || 'TU_TOKEN',
  COLMADO_NUMBER: process.env.COLMADO_NUMBER || '18099999999',
  PORT: process.env.PORT || 3000
};

const SA = {
  client_email: 'firebase-adminsdk-fbsvc@colmado-ia.iam.gserviceaccount.com',
  private_key: `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD3Sd4gkA6LYdsJ
oSOA3pGtFc3YZFYCdfIC6boqP9sIpSkmKxvwXWM0f+YGMsJ+aK9hHvScG6IJZC7H
lpdkpQrbi5DBX/BJOYen+m/PGtz/FTNHlKxzug+2ahFJFJ/PlOaK6m1M0/WC76SL
fY7Kx3GnQRIr93viTHGcQm5nj5gjwfEY3FGIoVu+dHJI7i2r6S4K1VxaKoEC3MW9
uO5TwArEdF6VTm1HZplnMjyftTTQgOLvSTJZvvq5Rv8fwL2Kqco1AjLxrFr+RIBt
WgjAzNpCypoUUCg7q0svG6TCzmQx/8GdkBYiCU6sJEJkyuYOni2iLnV2MyUl61Ui
MOY8A7DNAgMBAAECggEAEZtYNHG6IPrW3jwNGHtAXG/r/kp096t8KSO8SVvO9Zhr
PwUP8f13apQcrAS0y/+zu2Xso3ZlA03EKU1m+n4bZGXu6MXMiJPCPX4oTdLebBvc
HdTPfohMRbNBoQMJHReMXqGx8vSe5QBSpksXSqE7gPdLtIbkP2Jf+6QDOZGdkuLa
H/b0Y6I5MFD9O1PEJXgIDCPmBPZIpSd82gq60o89DGzsI0st04jAmKHsVZeC4oB3
g0J8AXp7YDwetA4VzqH+uZsRfML5WWtNdN6OQsc3TsMhaHhB9Fzg+r6hRcdW/du/
VCyP1fiAcDJfUnyr/vGqHrwtZBvvZOg2c0828LX5ZQKBgQD/KhYfEY/saGNiEBGd
IXGj5VlfVMNyArxgfIhYTB8o14svw7UUGeftf3s2rIHsWxNIKBY6ho3c+QsgAXDM
+AwZyiQdu6mqYCGJP7A+KkPf4/HRvuJeHKCDaSJ+J5AlEjo/8toKAl3Hrsc1HdBR
tzd8siaLOUMQ9WL5yO6Kk3ZI2wKBgQD4GS28haZf7x+mEUimozuwaL+2h8AiFzHJ
Yf+n8WqthGNf/Fo/70ghgm6VnjGT/iugQeeuldyR5lByzIuuhcn5/8l4qhBEj4eA
rTfbQkinAJ+mdiU0d0JnPFr1fi/t1vjenpIOkwRC+gFb4ZUAktM0t7m9Y3o00c5z
n8l7YlJpdwKBgQCH8IEWjkGx/i8sWEk6AE5Ntet2SW9Stzhq4w20lOFo3eRuTwKS
sfaI5gjbqO4S4LaWE508EuFTX27Y30ucN24i8zloickrVsmnGEIp7FR63DLBvsNU
xkWRnRpeQW+fAGX+GcCl4nrZ3jiNCNQqJMUv7q1wMNKVH1ZaovzK4SL8TwKBgQCa
tfjTavSJNnCh+n03jOsX4vpKNPUXTSd60WW/sMg5VCk0HgWZgPmWC+Qx4OhBxWon
EXIMaN+XC+x26h7gwgVlpKBaYpKqbmatU1dVn0v2+GiWQW6J/SSng/ekxv/UbQ3c
pT2nYP5zVburNEzagrS6Vye4dmQqs/ruF2JpUrLZmQKBgDA2GalyNXJHJByjpVRC
HEBp1f55XTMHjfSHlEA4XmfQ9mGCbVxIrL8VHnUvEMoHYZzL+7UhmbBvEVHsRJh1
3tehiZB6MgV7utO5AIqYhdirVBSiGVzUmE2wzEYM/+0Rb+KqmkqoWKUIwN5ruH9o
2H68V+ddX5GNYolS40+XsLUZ
-----END PRIVATE KEY-----`,
  project_id: 'colmado-ia'
};

let _cachedToken = null;
let _tokenExpiry = 0;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getFirebaseToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = b64url(sign.sign(SA.private_key));
  const jwt = `${header}.${payload}.${sig}`;
  const resp = await post('https://oauth2.googleapis.com/token', null, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  }, 'application/x-www-form-urlencoded');
  _cachedToken = resp.access_token;
  _tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
  return _cachedToken;
}

function httpRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function post(url, token, body, contentType = 'application/json') {
  const isForm = contentType.includes('x-www-form-urlencoded');
  const bodyStr = isForm
    ? Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : JSON.stringify(body);
  const headers = { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(bodyStr) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return httpRequest(url, 'POST', headers, bodyStr);
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: val } : { doubleValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFirestoreValue(v)])) } };
  }
  return { stringValue: String(val) };
}

async function savePedido(pedido) {
  const token = await getFirebaseToken();
  const docId = `pedido_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const url = `https://firestore.googleapis.com/v1/projects/colmado-ia/databases/(default)/documents/pedidos/${docId}`;
  const fields = Object.fromEntries(Object.entries(pedido).map(([k, v]) => [k, toFirestoreValue(v)]));
  const result = await httpRequest(url, 'PATCH',
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    JSON.stringify({ fields })
  );
  console.log('Pedido guardado:', docId, result.name ? 'OK' : JSON.stringify(result).slice(0, 100));
  return docId;
}

function parsearProductos(mensaje) {
  const msg = mensaje.toLowerCase();
  const productos = [];
  const patronCantidad = /(\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:libras?\s+de\s+)?([a-zÃ¡Ã©Ã­Ã³ÃºÃ¼Ã±\s]+?)(?=\s*(?:y|,|\.|$))/gi;
  const numeros = { un:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10 };
  let match;
  while ((match = patronCantidad.exec(msg)) !== null) {
    const cantStr = match[1].toLowerCase();
    const cantidad = numeros[cantStr] || parseInt(cantStr, 10) || 1;
    const nombre = match[2].trim().replace(/\s+/g, ' ');
    if (nombre.length > 1) productos.push({ nombre, cantidad, unidad: msg.includes('libra') ? 'libras' : 'unidades' });
  }
  if (!productos.length) productos.push({ nombre: mensaje.slice(0, 80), cantidad: 1, unidad: 'unidades' });
  return productos;
}

async function responderWhatsApp(chatId, mensaje) {
  if (!CONFIG.GREEN_INSTANCE_ID || CONFIG.GREEN_INSTANCE_ID === 'TU_INSTANCE_ID') return;
  const url = `https://api.green-api.com/waInstance${CONFIG.GREEN_INSTANCE_ID}/sendMessage/${CONFIG.GREEN_TOKEN}`;
  try {
    await post(url, null, { chatId, message: mensaje });
    console.log('Respuesta enviada a', chatId);
  } catch (e) { console.error('Error respondiendo WhatsApp:', e.message); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('IAcolmado Webhook Running OK');
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const event = JSON.parse(body);
      console.log('Evento recibido:', event.typeWebhook);
      if (event.typeWebhook === 'incomingMessageReceived' && event.messageData?.typeMessage === 'textMessage') {
        const mensaje = event.messageData.textMessageData.textMessage;
        const sender = event.senderData?.sender || '';
        const senderName = event.senderData?.senderName || 'Cliente';
        if (sender.includes(CONFIG.COLMADO_NUMBER)) { res.writeHead(200); return res.end('OK'); }
        console.log(`Mensaje de ${senderName} (${sender}): "${mensaje}"`);
        const productos = parsearProductos(mensaje);
        const pedido = { cliente: sender, nombreCliente: senderName, mensajeOriginal: mensaje, productos, hora: new Date(), estado: 'pendiente' };
        const docId = await savePedido(pedido);
        await responderWhatsApp(sender, `Hola ${senderName}! Recibimos tu pedido: "${mensaje}". Te avisamos cuando este listo.`);
        console.log('Pedido procesado:', docId);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('Error procesando webhook:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(CONFIG.PORT, () => {
  console.log(`IAcolmado Webhook activo en puerto ${CONFIG.PORT}`);
});
