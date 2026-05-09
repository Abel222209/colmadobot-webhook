const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Firebase Init
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// OpenAI Init
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Variables de entorno
const GREEN_API_ID    = process.env.GREEN_API_ID;
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;
const GREEN_BASE      = `https://api.green-api.com/waInstance${GREEN_API_ID}`;

// Horario del colmado (UTC-4 Republica Dominicana)
function estaAbierto() {
  const ahora = new Date();
    const hora = ahora.getUTCHours() - 4;
      return hora >= 7 && hora < 22;
      }

      // Enviar mensaje WhatsApp
      async function enviarMensaje(chatId, texto) {
        try {
            await axios.post(`${GREEN_BASE}/sendMessage/${GREEN_API_TOKEN}`, {
                  chatId,
                        message: texto,
                            });
                              } catch (err) {
                                  console.error('Error enviando mensaje:', err.message);
                                    }
                                    }

                                    // Descargar audio de Green API
                                    async function descargarAudio(url) {
                                      const response = await axios.get(url, { responseType: 'arraybuffer' });
                                        const tmpPath = path.join('/tmp', `audio_${Date.now()}.ogg`);
                                          fs.writeFileSync(tmpPath, response.data);
                                            return tmpPath;
                                            }

                                            // Transcribir audio con Whisper
                                            async function transcribirAudio(filePath) {
                                              const transcripcion = await openai.audio.transcriptions.create({
                                                  file: fs.createReadStream(filePath),
                                                      model: 'whisper-1',
                                                          language: 'es',
                                                            });
                                                              fs.unlinkSync(filePath);
                                                                return transcripcion.text;
                                                                }

                                                                // Procesar pedido con GPT
                                                                async function procesarPedido(texto, nombreCliente) {
                                                                  const systemPrompt = `
                                                                  Eres el asistente de un colmado dominicano. Tu tarea es analizar mensajes de clientes
                                                                  y extraer pedidos de productos.

                                                                  Vocabulario local:
                                                                  - "fria" = cerveza fria (generalmente Presidente)
                                                                  - "romo" = ron
                                                                  - "cuelito" = cuello de pollo
                                                                  - "chinola" = maracuya
                                                                  - "lechosa" = papaya
                                                                  - "funche" = harina de maiz
                                                                  - "pan de agua" = pan suave dominicano
                                                                  - "funda" = bolsa plastica
                                                                  - "palo" = bebida alcoholica generica

                                                                  Si el mensaje ES un pedido responde SOLO con este JSON:
                                                                  {
                                                                    "esPedido": true,
                                                                      "nombreCliente": "<nombre si lo menciono, si no usa '${nombreCliente}'>",
                                                                        "productos": [
                                                                            { "nombre": "<producto>", "cantidad": <numero> }
                                                                              ]
                                                                              }

                                                                              Si NO es un pedido responde SOLO con:
                                                                              { "esPedido": false }

                                                                              No agregues texto fuera del JSON.
                                                                              `;

                                                                                const response = await openai.chat.completions.create({
                                                                                    model: 'gpt-4o-mini',
                                                                                        messages: [
                                                                                              { role: 'system', content: systemPrompt },
                                                                                                    { role: 'user', content: texto },
                                                                                                        ],
                                                                                                            temperature: 0.2,
                                                                                                              });
                                                                                                              
                                                                                                                try {
                                                                                                                    return JSON.parse(response.choices[0].message.content);
                                                                                                                      } catch {
                                                                                                                          return { esPedido: false };
                                                                                                                            }
                                                                                                                            }
                                                                                                                            
                                                                                                                            // Guardar pedido en Firestore
                                                                                                                            async function guardarPedido(chatId, nombreCliente, productos, mensajeOriginal) {
                                                                                                                              const pedidoId = uuidv4();
                                                                                                                                await db.collection('pedidos').doc(pedidoId).set({
                                                                                                                                    cliente: chatId,
                                                                                                                                        nombreCliente,
                                                                                                                                            hora: new Date().toISOString(),
                                                                                                                                                estado: 'nuevo',
                                                                                                                                                    mensajeOriginal,
                                                                                                                                                        productos,
                                                                                                                                                          });
                                                                                                                                                            return pedidoId;
                                                                                                                                                            }
                                                                                                                                                            
                                                                                                                                                            // Webhook principal
                                                                                                                                                            app.post('/webhook', async (req, res) => {
                                                                                                                                                              res.sendStatus(200);
                                                                                                                                                              
                                                                                                                                                                try {
                                                                                                                                                                    const body = req.body;
                                                                                                                                                                    
                                                                                                                                                                        if (body.typeWebhook !== 'incomingMessageReceived') return;
                                                                                                                                                                        
                                                                                                                                                                            const messageData = body.messageData;
                                                                                                                                                                                const chatId      = body.senderData?.chatId;
                                                                                                                                                                                    const senderName  = body.senderData?.senderName || 'Cliente';
                                                                                                                                                                                        let textoFinal    = '';
                                                                                                                                                                                        
                                                                                                                                                                                            if (messageData?.typeMessage === 'audioMessage' ||
                                                                                                                                                                                                    messageData?.typeMessage === 'pttMessage') {
                                                                                                                                                                                                          const audioUrl = messageData.fileMessageData?.downloadUrl;
                                                                                                                                                                                                                if (!audioUrl) return;
                                                                                                                                                                                                                      const filePath = await descargarAudio(audioUrl);
                                                                                                                                                                                                                            textoFinal     = await transcribirAudio(filePath);
                                                                                                                                                                                                                                  console.log(`Audio transcrito [${chatId}]: ${textoFinal}`);
                                                                                                                                                                                                                                      } else if (messageData?.typeMessage === 'textMessage') {
                                                                                                                                                                                                                                            textoFinal = messageData.textMessageData?.textMessage || '';
                                                                                                                                                                                                                                                  console.log(`Texto recibido [${chatId}]: ${textoFinal}`);
                                                                                                                                                                                                                                                      } else return;
                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                          if (!textoFinal.trim()) return;
                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                              if (!estaAbierto()) {
                                                                                                                                                                                                                                                                    await enviarMensaje(chatId, 'Estamos cerrados. Abrimos a las 7AM. Hasta luego!');
                                                                                                                                                                                                                                                                          return;
                                                                                                                                                                                                                                                                              }
                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                  const resultado = await procesarPedido(textoFinal, senderName);
                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                      if (!resultado.esPedido) {
                                                                                                                                                                                                                                                                                            await enviarMensaje(chatId, 'No entendi bien tu pedido. Puedes decirme que necesitas?');
                                                                                                                                                                                                                                                                                                  return;
                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                          const pedidoId = await guardarPedido(
                                                                                                                                                                                                                                                                                                                chatId,
                                                                                                                                                                                                                                                                                                                      resultado.nombreCliente,
                                                                                                                                                                                                                                                                                                                            resultado.productos,
                                                                                                                                                                                                                                                                                                                                  textoFinal
                                                                                                                                                                                                                                                                                                                                      );
                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                          console.log(`Pedido guardado [${pedidoId}]:`, resultado.productos);
                                                                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                                                              const listaProductos = resultado.productos
                                                                                                                                                                                                                                                                                                                                                    .map(p => `- ${p.cantidad}x ${p.nombre}`)
                                                                                                                                                                                                                                                                                                                                                          .join('\n');
                                                                                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                                                                              await enviarMensaje(
                                                                                                                                                                                                                                                                                                                                                                    chatId,
                                                                                                                                                                                                                                                                                                                                                                          `Pedido recibido, ${resultado.nombreCliente}!\n\n${listaProductos}\n\nEn unos minutos esta listo`
                                                                                                                                                                                                                                                                                                                                                                              );
                                                                                                                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                                                                                                                } catch (err) {
                                                                                                                                                                                                                                                                                                                                                                                    console.error('Error en webhook:', err);
                                                                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                                                                      });
                                                                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                                                                      // Health check
                                                                                                                                                                                                                                                                                                                                                                                      app.get('/', (req, res) => res.send('ColmadoBot activo'));
                                                                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                                                                      const PORT = process.env.PORT || 3000;
                                                                                                                                                                                                                                                                                                                                                                                      app.listen(PORT, () => console.log(`ColmadoBot corriendo en puerto ${PORT}`));
