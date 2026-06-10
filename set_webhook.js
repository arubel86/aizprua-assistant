const fs = require('fs');
const https = require('https');
const path = require('path');

// 1. Leer el token de Telegram desde .dev.vars
const varsPath = path.join(__dirname, '.dev.vars');
let botToken = process.env.TELEGRAM_BOT_TOKEN;

if (fs.existsSync(varsPath)) {
  const content = fs.readFileSync(varsPath, 'utf8');
  const match = content.match(/TELEGRAM_BOT_TOKEN="([^"]+)"/);
  if (match && match[1]) {
    botToken = match[1];
  }
}

if (!botToken) {
  console.error("❌ No se pudo encontrar TELEGRAM_BOT_TOKEN en .dev.vars");
  process.exit(1);
}

// 2. URL del Worker de Cloudflare
const workerUrl = "https://aizprua-assistant.arubel68.workers.dev";
const apiUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${workerUrl}`;

// 3. Ejecutar la petición para registrar el webhook
https.get(apiUrl, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      if (result.ok) {
        console.log(`✅ Webhook protegido/configurado exitosamente a: ${workerUrl}`);
      } else {
        console.error("⚠️ Error configurando Webhook:", result.description);
      }
    } catch (e) {
      console.error("⚠️ Error al interpretar la respuesta de Telegram:", e);
    }
  });
}).on('error', (err) => {
  console.error("❌ Error de red al intentar configurar el Webhook:", err.message);
});
