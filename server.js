const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GREEN_API_URL = 'https://7107.api.greenapi.com';
const ID_INSTANCE = process.env.GREEN_API_ID;
const API_TOKEN = process.env.GREEN_API_TOKEN;
const BOT_PHONE = process.env.BOT_PHONE || '18498028229';

function estaAbierto() {
  const now = new Date();
  const horaRD = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santo_Domingo' }));
  const hora = horaRD.getHours();
  return hora >= 7 && hora < 22;
}

async function enviarMensaje(chatId, mensaje) {
  try {
    await axios.post(
      `${GREEN_API_URL}/waInstance${ID_INSTANCE}/sendMessage/${API_TOKEN}`,
      { chatId, message: mensaje }
    );
  } catch (e) {
    console.error('Error enviando mensaje:', e.message);
  }
}

async function descargarAudio(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  const tmpPath = path.join('/tmp', uuidv4() + '.ogg');
  fs.writeFileSync(tmpPath, resp.data);
  return tmpPath;
}

async function transcribirAudio(audioPath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    language: 'es'
  });
  fs.unlinkSync(audioPath);
  return transcription.text;
}

async function procesarPedido(texto) {
  const systemPrompt = `Eres el asistente de ColmadoBot, un colmado dominicano. Tu trabajo es leer mensajes de clientes e identificar pedidos.

Vocabulario dominicano:
- fria/frias = cerveza(s) fria(s)
- romo = ron
- lechosa = papaya
- habichuela = frijol
- funda = bolsa
- coca grande = Coca-Cola 2L
- pesito de = porcion pequena de
- malta grande/pequena = malta Morena segun tamano

Responde UNICAMENTE con JSON valido, sin texto adicional antes ni despues.

Si ES un pedido de productos:
{"esPedido":true,"productos":["producto1","producto2"],"respuesta":"Anotao! Te llevo [menciona los productos]. Dame un momentico!"}

Si NO es un pedido (saludo, pregunta general, etc.):
{"esPedido":false,"respuesta":"Buenas! Soy el asistente del colmado. Que vas a necesitar hoy?"}

REGLAS:
- El campo 'respuesta' DEBE ser un mensaje real y personalizado basado en lo que dijo el cliente
- Para pedidos: menciona los productos especificos que pidio
- Para no-pedidos: responde de forma natural al contexto del mensaje
- Usa tono amigable en espanol dominicano
- NO copies literalmente los ejemplos, adaptalos al mensaje real`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: texto }
    ],
    temperature: 0.3
  });

  const content = completion.choices[0].message.content.trim();
  console.log('GPT raw:', content);
  try {
    const cleaned = content.replace(/^[\s\S]*?({)/,'$1').replace(/(})[^}]*$/,'$1');
    return JSON.parse(cleaned);
  } catch {
    return { esPedido: false, respuesta: 'Disculpa, no entendi tu mensaje. Puedes repetirlo?' };
  }
}

async function guardarPedido(chatId, nombreCliente, mensajeOriginal, productos) {
  const pedido = {
    cliente: chatId,
    nombreCliente: nombreCliente || chatId.replace('@c.us', ''),
    hora: admin.firestore.FieldValue.serverTimestamp(),
    estado: 'nuevo',
    mensajeOriginal,
    productos
  };
  await db.collection('pedidos').add(pedido);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.typeWebhook !== 'incomingMessageReceived') return;

    const messageData = body.messageData;
    const senderData = body.senderData;
    const chatId = senderData && senderData.chatId;
    const senderName = (senderData && senderData.senderName) || '';

    if (!chatId) return;
    if (chatId.includes('@g.us')) return;
    if (chatId === BOT_PHONE + '@c.us') return;

    let textoMensaje = '';
    if (messageData && messageData.typeMessage === 'textMessage') {
      textoMensaje = (messageData.textMessageData && messageData.textMessageData.textMessage) || '';
    } else if (messageData && (messageData.typeMessage === 'audioMessage' || messageData.typeMessage === 'voiceMessage')) {
      const audioUrl = messageData.fileMessageData && messageData.fileMessageData.downloadUrl;
      if (audioUrl) {
        try {
          const audioPath = await descargarAudio(audioUrl);
          textoMensaje = await transcribirAudio(audioPath);
          console.log('Audio transcrito:', textoMensaje);
        } catch (e) {
          console.error('Error transcribiendo audio:', e.message);
          await enviarMensaje(chatId, 'No pude escuchar tu audio. Puedes escribirme el pedido?');
          return;
        }
      }
    } else { return; }

    if (!textoMensaje.trim()) return;
    console.log('Mensaje de', senderName, '(', chatId, '):', textoMensaje);

    if (!estaAbierto()) {
      await enviarMensaje(chatId, 'Wao, el colmado esta cerrado ahora mismo. Abrimos de 7am a 10pm. Anotate el pedido y nos escribes manana!');
      return;
    }

    const resultado = await procesarPedido(textoMensaje);
    console.log('Resultado:', JSON.stringify(resultado));

    if (resultado.esPedido) {
      await guardarPedido(chatId, senderName, textoMensaje, resultado.productos);
      console.log('Pedido guardado para:', senderName);
    }
    await enviarMensaje(chatId, resultado.respuesta);

  } catch (e) {
    console.error('Error en webhook:', e);
  }
});

app.get('/api/pedidos', async (req, res) => {
  try {
    const snapshot = await db.collection('pedidos').limit(100).get();
    const pedidos = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      pedidos.push({
        id: doc.id,
        ...data,
        hora: data.hora ? data.hora.toDate().toISOString() : null
      });
    });
    pedidos.sort((a, b) => {
      if (!a.hora) return 1;
      if (!b.hora) return -1;
      return new Date(b.hora) - new Date(a.hora);
    });
    res.json(pedidos);
  } catch (e) {
    console.error('Error obteniendo pedidos:', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/pedidos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body;
    if (!['nuevo', 'preparando', 'listo'].includes(estado)) {
      return res.status(400).json({ error: 'Estado invalido' });
    }
    await db.collection('pedidos').doc(id).update({ estado });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error actualizando pedido:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => { res.send('ColmadoBot activo'); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('ColmadoBot corriendo en puerto ' + PORT); });
