const fs = require('fs');
const https = require('https');
const path = require('path');

const varsPath = path.join(__dirname, '.dev.vars');
let botToken = process.env.TELEGRAM_BOT_TOKEN;

if (fs.existsSync(varsPath)) {
  const content = fs.readFileSync(varsPath, 'utf8');
  const match = content.match(/TELEGRAM_BOT_TOKEN="?([^"\s]+)"?/);
  if (match && match[1]) {
    botToken = match[1];
  }
}

if (!botToken) {
  console.error("No se pudo encontrar TELEGRAM_BOT_TOKEN en .dev.vars");
  process.exit(1);
}

const commands = [
  { command: "start", description: "Iniciar el asistente de Aizprua S.E." },
  { command: "sync", description: "Sincronizar base de conocimiento desde GitHub (admin)" },
  { command: "health", description: "Diagnóstico del sistema (admin)" },
  { command: "model", description: "Ver o cambiar el modelo de IA (admin)" },
  { command: "allow", description: "Autorizar un usuario por ID (admin)" },
  { command: "revoke", description: "Revocar acceso de un usuario (admin)" },
  { command: "whitelist", description: "Listar usuarios autorizados (admin)" },
  { command: "clear", description: "Borrar historial de conversación" }
];

const data = JSON.stringify({ commands });
const apiUrl = `https://api.telegram.org/bot${botToken}/setMyCommands`;

const req = https.request(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, (res) => {
  let responseData = '';
  res.on('data', chunk => responseData += chunk);
  res.on('end', () => {
    const result = JSON.parse(responseData);
    if (result.ok) {
      console.log("Comandos registrados exitosamente:");
      commands.forEach(c => console.log(`  /${c.command} - ${c.description}`));
    } else {
      console.error("Error registrando comandos:", result.description);
    }
  });
});

req.on('error', (err) => {
  console.error("Error de red:", err.message);
});

req.write(data);
req.end();
