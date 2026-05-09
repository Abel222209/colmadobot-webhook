const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Servir archivos estaticos del panel
app.use(express.static(path.join(__dirname, 'public')));

// Ruta del panel
app.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Firebase Init
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// OpenAI Init
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Green API config
const GREEN_API_URL = 'https://7107.api.greenapi.com';
const ID_INSTANCE = process.env.GREEN_API_ID;
const API_TOKEN = process.env.GREEN_API_TOKEN;

// Horario: 7am - 10pm hora RD (UTC-4)
function estaAbierto() {
  const now = new Date();
  const horaRD = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santo_Domingo' }));
  const hora = horaRD.getHours();
  return hora >= 7 && hora < 22;
}

// Enviar mensaje por WhatsApp
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

// Descargar audio
async function descargarAudio(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  const tmpPath = path.join('/tmp', uuidv4() + '.ogg');
  fs.writeFileSync(tmpPath, resp.data);
  return tmpPath;
}

// Transcribir audio con Whisper
async function transcribirAudio(audioPath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    language: 'es'
  });
  fs.unlinkSync(audioPath);
  return transcription.text;
}

// Procesar pedido con GPT
async function procesarPedido(texto) {
  const systemPrompt = `Eres el asistente de un colmado dominicano. Tu tarea es identificar si el mensaje es un pedido de productos.

Vocabulario dominicano:
- fria/frias = cerveza(s) fria(s)
- romo = ron
- lechosa = papaya
- habichuela = frijol
- yuca, platano, guineo = productos tipicos
- funda = bolsa
- vaina = cosa/producto
- dimelo = dime que necesitas

Si ES un pedido, responde en JSON:
{
  "esPedido": true,
  "productos": ["lista de productos identificados"],
  "respuesta": "Mensaje de confirmacion amigable en espanol dominicano"
}

Si NO es un pedido, responde en JSON:
{
  "esPedido": false,
  "respuesta": "Respuesta amigable"
}

Solo responde con el JSON, sin explicaciones adicionales.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: texto }
    ],
    temperature: 0.3
  });

  const content = completion.choices[0].message.content.trim();
  try {
    return JSON.parse(content);
  } catch {
    return { esPedido: false, respuesta: 'Disculpa, no entendi tu mensaje. Puedes repetirlo?' };
  }
}

// Guardar pedido en Firestore
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

// Webhook principal
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    // Solo procesar mensajes entrantes
    if (body.typeWebhook !== 'incomingMessageReceived') return;

    const messageData = body.messageData;
    const senderData = body.senderData;
    const chatId = senderData?.chatId;
    const senderName = senderData?.senderName || '';

    if (!chatId || chatId.includes('@g.us')) return; // Ignorar grupos

    let textoMensaje = '';

    if (messageData?.typeMessage === 'textMessage') {
      textoMensaje = messageData.textMessageData?.textMessage || '';
    } else if (messageData?.typeMessage === 'audioMessage' || messageData?.typeMessage === 'voiceMessage') {
      const audioUrl = messageData.fileMessageData?.downloadUrl;
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
    } else {
      return; // Ignorar otros tipos
    }

    if (!textoMensaje.trim()) return;

    console.log(`Mensaje de ${senderName} (${chatId}): ${textoMensaje}`);

    // Verificar horario
    if (!estaAbierto()) {
      await enviarMensaje(chatId, 'Wao, el colmado esta cerrado ahora mismo. Abrimos de 7am a 10pm. Anota tu pedido y nos escribes mas tarde! 🌙');
      return;
    }

    // Procesar con GPT
    const resultado = await procesarPedido(textoMensaje);

    if (resultado.esPedido) {
      await guardarPedido(chatId, senderName, textoMensaje, resultado.productos);
      await enviarMensaje(chatId, resultado.respuesta);
    } else {
      await enviarMensaje(chatId, resultado.respuesta);
    }

  } catch (e) {
    console.error('Error en webhook:', e);
  }
});

// API para el panel - obtener pedidos
app.get('/api/pedidos', async (req, res) => {
  try {
    const snapshot = await db.collection('pedidos')
      .orderBy('hora', 'desc')
      .limit(100)
      .get();

    const pedidos = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      pedidos.push({
        id: doc.id,
        ...data,
        hora: data.hora ? data.hora.toDate().toISOString() : null
      });
    });

    res.json(pedidos);
  } catch (e) {
    console.error('Error obteniendo pedidos:', e);
    res.status(500).json({ error: e.message });
  }
});

// API para el panel - actualizar estado
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

// Ruta raiz
app.get('/', (req, res) => {
  res.send('ColmadoBot activo');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ColmadoBot corriendo en puerto ${PORT}`);
});
