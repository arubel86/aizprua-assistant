export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  GEMINI_API_KEY: string;
  ADMIN_TELEGRAM_ID: string;
  AIZPRUA_WIKI_KV: KVNamespace;
  AI: any; // Binding nativo de Cloudflare Workers AI
  WEBHOOK_SECRET?: string; // Secreto para verificar webhooks de GitHub
  GEMINI_MODEL?: string; // Modelo de Gemini a usar (default: gemini-2.5-flash)
  OPENROUTER_API_KEY?: string; // API key de OpenRouter (fallback alternativo a Gemini)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Si la petición no es POST, respondemos OK (puede ser un GET de prueba en navegador)
    if (request.method !== "POST") {
      return new Response("Asistente de Aizprua S.E. está funcionando. 🤖", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    try {
      // Verificar si es un webhook de GitHub (por el header X-GitHub-Event)
      const githubEvent = request.headers.get("X-GitHub-Event");
      if (githubEvent) {
        return await handleGitHubWebhookRequest(request, env, ctx);
      }

      const payload = await request.json() as any;
      if (!payload) {
        return new Response("No payload", { status: 200 });
      }

      if (!payload.message) {
        return new Response("No message payload", { status: 200 });
      }

      const message = payload.message;
      const chatId = message.chat.id;
      const userId = message.from.id;
      const text = message.text ? message.text.trim() : "";

      if (!text) {
        return new Response("OK", { status: 200 });
      }

      // Explicación Racional: Verificación de Whitelist
      // Solo el administrador y los usuarios autorizados (cuyo ID se guardó en KV con prefijo 'whitelist:')
      // pueden interactuar con el bot. Esto previene el uso no autorizado y el consumo indebido de APIs.
      const isAdmin = userId.toString() === env.ADMIN_TELEGRAM_ID;
      let isWhitelisted = false;
      if (!isAdmin) {
        const whitelistVal = await env.AIZPRUA_WIKI_KV.get(`whitelist:${userId}`);
        if (whitelistVal) {
          isWhitelisted = true;
        }
      }

      // Si no es admin ni está autorizado, denegamos el acceso y alertamos al admin.
      if (!isAdmin && !isWhitelisted) {
        const username = message.from.username || "";
        const firstName = message.from.first_name || "";
        const lastName = message.from.last_name || "";

        await sendTelegramMessage(
          env,
          chatId,
          `Lo siento, este asistente está restringido para uso exclusivo de clientes y personal autorizado de *Aizprua S.E.*\n\nSi es cliente y requiere acceso, por favor contacte a su asesor facilitando su ID de Telegram: \`${userId}\`.`
        );

        // Envía una alerta al administrador sobre el intento de acceso no autorizado
        const alertMsg = `⚠️ *Intento de Acceso No Autorizado*\n\n*Nombre:* ${firstName} ${lastName}\n*Usuario:* ${username ? `@${username}` : "_No tiene_"}\n*ID:* \`${userId}\`\n*Mensaje:* "${text}"`;
        ctx.waitUntil(sendTelegramMessage(env, parseInt(env.ADMIN_TELEGRAM_ID), alertMsg));
        return new Response("OK", { status: 200 });
      }

      // Comando de inicio
      if (text === "/start") {
        const username = message.from.username || "";
        const firstName = message.from.first_name || "";
        const lastName = message.from.last_name || "";

        await sendTelegramMessage(
          env,
          chatId,
          "¡Hola! Soy tu asistente de *Aizprua S.E.* 🤖\n\nPregúntame lo que quieras sobre nuestros trámites y servicios de asesoría contable, legal o tributaria. Estoy listo para ayudarte con nuestra base de conocimiento."
        );

        // Envía una alerta silenciosa al administrador en segundo plano si es un usuario nuevo
        ctx.waitUntil(checkAndAlertAdmin(env, userId, username, firstName, lastName));
        return new Response("OK", { status: 200 });
      }

      // Comando de sincronización (solo admin)
      if (text === "/sync") {
        if (!isAdmin) {
          await sendTelegramMessage(env, chatId, "Lo siento, no tienes permisos de administrador para sincronizar la base de conocimiento. ❌");
          return new Response("OK", { status: 200 });
        }

        await sendTelegramMessage(env, chatId, "Sincronizando la base de conocimiento desde GitHub... ⏳");
        try {
          await syncGitHubWiki(env, chatId);
        } catch (err: any) {
          const errMsg = err.message || err;
          await sendTelegramMessage(env, chatId, `Error durante la sincronización: ${errMsg} ❌`);
          ctx.waitUntil(alertAdmin(env, "SYNC_FAIL", errMsg));
        }
        return new Response("OK", { status: 200 });
      }

      // Comando de diagnóstico (solo admin)
      if (text === "/health") {
        if (!isAdmin) {
          await sendTelegramMessage(env, chatId, "Lo siento, no tienes permisos de administrador para ejecutar diagnósticos. ❌");
          return new Response("OK", { status: 200 });
        }

        await sendTelegramMessage(env, chatId, "Iniciando diagnóstico del sistema... 🏥⏳");
        ctx.waitUntil((async () => {
          try {
            const report = await runSystemDiagnostics(env);
            await sendTelegramMessage(env, chatId, report);
          } catch (err: any) {
            await sendTelegramMessage(env, chatId, `Error al ejecutar diagnóstico: ${err.message || err} ❌`);
          }
        })());
        return new Response("OK", { status: 200 });
      }

      // Comando para limpiar el historial de chat y evitar que el bot recuerde alucinaciones pasadas
      if (text === "/clear") {
        await env.AIZPRUA_WIKI_KV.delete(`chat_history:${chatId}`);
        await sendTelegramMessage(env, chatId, "🧹 El historial de conversación ha sido borrado. Ya no recordaré los mensajes anteriores.");
        return new Response("OK", { status: 200 });
      }

  // Explicación Racional: Comandos de Administración de Whitelist
  // Permiten al admin agregar, remover y ver los usuarios autorizados directamente desde Telegram.
      
      // Comando para autorizar usuarios (solo admin)
      if (text.startsWith("/allow")) {
        if (!isAdmin) {
          await sendTelegramMessage(env, chatId, "Lo siento, no tienes permisos de administrador. ❌");
          return new Response("OK", { status: 200 });
        }

        const parts = text.split(/\s+/);
        const targetId = parts[1];
        if (!targetId || isNaN(Number(targetId))) {
          await sendTelegramMessage(env, chatId, "Por favor, especifica un ID de usuario válido. Ejemplo: `/allow 12345678` ⚠️");
          return new Response("OK", { status: 200 });
        }

        const note = parts.slice(2).join(" ") || "Usuario autorizado";
        await env.AIZPRUA_WIKI_KV.put(`whitelist:${targetId}`, JSON.stringify({
          authorizedAt: new Date().toISOString(),
          note: note
        }));

        await sendTelegramMessage(env, chatId, `✅ Usuario \`${targetId}\` (${note}) ha sido autorizado y añadido a la whitelist.`);
        return new Response("OK", { status: 200 });
      }

      // Comando para revocar autorización (solo admin)
      if (text.startsWith("/revoke")) {
        if (!isAdmin) {
          await sendTelegramMessage(env, chatId, "Lo siento, no tienes permisos de administrador. ❌");
          return new Response("OK", { status: 200 });
        }

        const parts = text.split(/\s+/);
        const targetId = parts[1];
        if (!targetId || isNaN(Number(targetId))) {
          await sendTelegramMessage(env, chatId, "Por favor, especifica un ID de usuario válido. Ejemplo: `/revoke 12345678` ⚠️");
          return new Response("OK", { status: 200 });
        }

        await env.AIZPRUA_WIKI_KV.delete(`whitelist:${targetId}`);
        await sendTelegramMessage(env, chatId, `❌ Acceso revocado para el usuario \`${targetId}\`.`);
        return new Response("OK", { status: 200 });
      }

      // Comando para listar whitelist (solo admin)
      if (text === "/whitelist") {
        if (!isAdmin) {
          await sendTelegramMessage(env, chatId, "Lo siento, no tienes permisos de administrador. ❌");
          return new Response("OK", { status: 200 });
        }

        const list = await env.AIZPRUA_WIKI_KV.list({ prefix: "whitelist:" });
        if (list.keys.length === 0) {
          await sendTelegramMessage(env, chatId, "La whitelist de usuarios autorizados está vacía. 📋");
          return new Response("OK", { status: 200 });
        }

        let report = `📋 *Usuarios Autorizados (Whitelist)*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const key of list.keys) {
          const valStr = await env.AIZPRUA_WIKI_KV.get(key.name);
          const uId = key.name.replace("whitelist:", "");
          let note = "";
          if (valStr) {
            try {
              const parsed = JSON.parse(valStr);
              note = parsed.note || "";
            } catch {
              note = valStr;
            }
          }
          report += `👤 ID: \`${uId}\` ${note ? `- ${note}` : ""}\n`;
        }
        await sendTelegramMessage(env, chatId, report);
        return new Response("OK", { status: 200 });
      }

      // Explicación Racional: Comando /model para Selección de Modelo de IA
      // Permite al admin cambiar entre: 'auto' (Gemini con fallbacks),
      // 'gemini' (solo Gemini) o 'llama' (solo OpenRouter + Cloudflare AI).
      if (text.startsWith("/model")) {
        if (!isAdmin) {
          await sendTelegramMessage(env, chatId, "Lo siento, no tienes permisos de administrador. ❌");
          return new Response("OK", { status: 200 });
        }

        const parts = text.split(/\s+/);
        const selectedModel = parts[1]?.toLowerCase();

        if (!selectedModel) {
          const currentModel = await env.AIZPRUA_WIKI_KV.get("bot:active_model") || "auto";
          const cooldown = await env.AIZPRUA_WIKI_KV.get("gemini_cooldown");

          const modelLabels: Record<string, string> = {
            "auto": "🔄 Automático (Gemini → OpenRouter → Cloudflare AI)",
            "gemini": "🤖 Gemini (forzado, sin respaldo)",
            "llama": "🧠 Nemotron + Cloudflare AI (sin Gemini)"
          };

          let statusMsg = `⚙️ *Configuración del Modelo de IA*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
          statusMsg += `📌 *Modo actual:* ${modelLabels[currentModel] || modelLabels["auto"]}\n`;
          if (currentModel === "auto" && cooldown) {
            statusMsg += `⏳ *Gemini en cooldown:* Usando OpenRouter/Nemotron (se reintentará Gemini automáticamente)\n`;
          }
          statusMsg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
          statusMsg += `*Comandos disponibles:*\n`;
          statusMsg += `• \`/model auto\` — Gemini → OpenRouter → Cloudflare AI\n`;
          statusMsg += `• \`/model gemini\` — Solo Gemini (sin respaldo)\n`;
          statusMsg += `• \`/model llama\` — Solo Nemotron + Cloudflare AI\n`;

          await sendTelegramMessage(env, chatId, statusMsg);
          return new Response("OK", { status: 200 });
        }

        if (!["auto", "gemini", "llama"].includes(selectedModel)) {
          await sendTelegramMessage(env, chatId, "Modelo no reconocido. Usa: `/model auto`, `/model gemini` o `/model llama` ⚠️");
          return new Response("OK", { status: 200 });
        }

        await env.AIZPRUA_WIKI_KV.put("bot:active_model", selectedModel);

        if (selectedModel !== "llama") {
          await env.AIZPRUA_WIKI_KV.delete("gemini_cooldown");
        }

        const confirmLabels: Record<string, string> = {
          "auto": "🔄 *Automático* — Gemini como principal, OpenRouter (Nemotron) como respaldo, Cloudflare AI como último recurso",
          "gemini": "🤖 *Gemini* — Solo Gemini, sin respaldo automático",
          "llama": "🧠 *Nemotron + Cloudflare AI* — Sin Gemini, usa OpenRouter y Cloudflare AI"
        };

        await sendTelegramMessage(env, chatId, `✅ Modelo de IA actualizado a:\n${confirmLabels[selectedModel]}`);
        return new Response("OK", { status: 200 });
      }

      // Procesar preguntas del negocio
      await handleUserQuery(env, chatId, text);

    } catch (error: any) {
      console.error("Error en el Handler:", error);
      try {
        await alertAdmin(env, "HANDLER_FAIL", error.message || error);
      } catch (_) {}
      return new Response("Error interno", { status: 500 });
    }

    return new Response("OK", { status: 200 });
  }
};

/**
 * Envía un mensaje a Telegram. Utiliza fallback sin formato si el parseo de Markdown falla.
 */
async function sendTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  const chunks = splitText(text, 4000);
  for (const chunk of chunks) {
    await sendSingleTelegramMessage(env, chatId, chunk);
  }
}

/**
 * Helper interno para enviar un único mensaje a Telegram.
 */
async function sendSingleTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    })
  });

  if (!res.ok) {
    // Si hay un error de parseo de Markdown, reintentamos mandando texto plano
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });
  }
}

/**
 * Descarga y sincroniza la wiki de GitHub guardando los archivos Markdown en Cloudflare KV.
 */
async function syncGitHubWiki(env: Env, chatId: number): Promise<void> {
  let filesSyncedCount = 0;
  const filesList: { name: string; path: string; download_url: string }[] = [];

  // Helper interno recursivo para explorar carpetas de GitHub
  async function traverse(path: string) {
    const url = `https://api.github.com/repos/arubel86/Aizpruase-Documentos-Tramites/contents/${encodeURIComponent(path)}`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "User-Agent": "Cloudflare-Worker-Telegram-Bot",
        "Accept": "application/vnd.github.v3+json"
      }
    });

    if (!response.ok) {
      if (response.status === 404) return;
      throw new Error(`Error al leer GitHub: ${path} (Status ${response.status})`);
    }

    const items = await response.json() as any[];
    for (const item of items) {
      // Ignorar archivos y carpetas ocultas/de configuración (.agents, .git, etc.)
      if (item.name.startsWith('.')) continue;

      // Ignorar carpetas de herramientas, scripts o proyectos de código
      if (
        item.path.includes('Video-Project') ||
        item.path.includes('Calculadora') ||
        item.path.includes('talnect-brain') ||
        item.path.includes('6. Herramientas')
      ) {
        continue;
      }

      if (item.type === 'dir') {
        await traverse(item.path);
      } else if (item.type === 'file' && item.name.endsWith('.md')) {
        filesList.push({
          name: item.name,
          path: item.path,
          download_url: item.download_url
        });
      }
    }
  }

  // Iniciar la exploración desde la raíz del repositorio
  await traverse("");

  // Mantener registro de las claves sincronizadas para borrar archivos obsoletos de KV
  const syncedKeys: string[] = [];

  for (const file of filesList) {
    const fileRes = await fetch(file.download_url, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "User-Agent": "Cloudflare-Worker-Telegram-Bot"
      }
    });

    if (fileRes.ok) {
      const content = await fileRes.text();
      // Guardar el documento original en KV
      await env.AIZPRUA_WIKI_KV.put(file.path, content);
      syncedKeys.push(file.path);
      
      // Calcular y guardar el embedding semántico
      try {
        const embedding = await generateEmbedding(env, content);
        if (embedding) {
          await env.AIZPRUA_WIKI_KV.put(`embedding:${file.path}`, JSON.stringify(embedding));
          syncedKeys.push(`embedding:${file.path}`);
        }
      } catch (embErr) {
        console.error(`Error al generar embedding para ${file.path}:`, embErr);
      }

      filesSyncedCount++;
    }
  }

  // Eliminar documentos y embeddings antiguos que ya no existan en el repositorio
  try {
    const list = await env.AIZPRUA_WIKI_KV.list();
    const syncedSet = new Set(syncedKeys);
    for (const key of list.keys) {
      // Solo limpiar claves del repositorio (archivos .md y sus embeddings)
      if (
        (key.name.endsWith(".md") || key.name.startsWith("embedding:")) &&
        !syncedSet.has(key.name)
      ) {
        await env.AIZPRUA_WIKI_KV.delete(key.name);
      }
    }
  } catch (cleanErr) {
    console.error("Error al limpiar claves antiguas en KV:", cleanErr);
  }

  await sendTelegramMessage(
    env,
    chatId,
    `¡Sincronización completada! 📚\nSe han actualizado y guardado ${filesSyncedCount} documentos (con sus respectivos embeddings semánticos) en la base de datos de Cloudflare KV.`
  );
}

/**
 * Maneja una petición entrante de webhook de GitHub.
 * Verifica la firma HMAC-SHA256 y procesa el evento.
 */
async function handleGitHubWebhookRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const githubEvent = request.headers.get("X-GitHub-Event") || "";
  const signature = request.headers.get("X-Hub-Signature-256") || "";

  // Verificar la firma si WEBHOOK_SECRET está configurado
  if (env.WEBHOOK_SECRET) {
    const body = await request.clone().text();
    const expectedSig = "sha256=" + await computeHMACSHA256(env.WEBHOOK_SECRET, body);
    if (!signature || expectedSig !== signature) {
      console.error("Firma de webhook inválida");
      return new Response("Firma inválida", { status: 401 });
    }

    // Procesar el payload después de verificar
    const payload = JSON.parse(body);

    // Ping event (se envía al configurar el webhook)
    if (githubEvent === "ping") {
      console.log("GitHub webhook ping recibido:", payload.zen || "OK");
      return new Response("pong", { status: 200 });
    }

    // Push event
    if (githubEvent === "push") {
      // Solo procesar pushes a main
      if (payload.ref !== "refs/heads/main") {
        return new Response("Rama ignorada", { status: 200 });
      }

      ctx.waitUntil(processGitHubPush(env, payload));
      return new Response("Sincronización iniciada", { status: 200 });
    }

    return new Response(`Evento ${githubEvent} ignorado`, { status: 200 });
  }

  // Si no hay WEBHOOK_SECRET, procesar igual pero con menos seguridad
  const payload = await request.json() as any;

  if (githubEvent === "ping") {
    return new Response("pong", { status: 200 });
  }

  if (githubEvent === "push" && payload.ref === "refs/heads/main") {
    ctx.waitUntil(processGitHubPush(env, payload));
    return new Response("Sincronización iniciada", { status: 200 });
  }

  return new Response("OK", { status: 200 });
}

/**
 * Procesa un push de GitHub a main: sincroniza la wiki y notifica al admin.
 */
async function processGitHubPush(env: Env, payload: any): Promise<void> {
  const repoFullName = payload.repository?.full_name || "desconocido";
  const pusherName = payload.pusher?.name || "desconocido";
  const commitCount = payload.commits?.length || 0;

  console.log(`GitHub push: ${commitCount} commits en ${repoFullName} por ${pusherName}`);

  await sendTelegramMessage(
    env,
    parseInt(env.ADMIN_TELEGRAM_ID),
    `🔄 *Sincronización automática iniciada*\n\nSe detectaron ${commitCount} nuevo(s) commit(s) en \`${repoFullName}\` por *${pusherName}*.\n\nActualizando base de conocimiento... ⏳`
  );

  try {
    await syncGitHubWiki(env, parseInt(env.ADMIN_TELEGRAM_ID));
  } catch (err: any) {
    const errMsg = err.message || err;
    console.error("Error en sincronización automática por webhook:", errMsg);
    await alertAdmin(env, "SYNC_FAIL", errMsg);
  }
}

/**
 * Calcula HMAC-SHA256 para verificar firmas de webhook de GitHub.
 */
async function computeHMACSHA256(secret: string, body: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const data = new TextEncoder().encode(body);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Filtra y devuelve únicamente los documentos relevantes de la base de conocimiento en base a las palabras clave de la pregunta.
 * Esto optimiza el consumo de tokens y evita desbordar el contexto de la IA.
 */
async function getRelevantContext(env: Env, query: string, list: any): Promise<string> {
  const docKeys = list.keys.filter((k: any) => k.name.endsWith(".md") && !k.name.startsWith("embedding:"));
  
  let queryVector: number[] | null = null;
  try {
    queryVector = await generateEmbedding(env, query);
  } catch (err) {
    console.error("Error al generar embedding de la consulta, usando fallback:", err);
  }

  if (!queryVector) {
    return getRelevantContextKeywordFallback(env, query, docKeys);
  }

  const similarities: { key: string; similarity: number }[] = [];

  for (const key of docKeys) {
    try {
      const embStr = await env.AIZPRUA_WIKI_KV.get(`embedding:${key.name}`);
      if (embStr) {
        const vector = JSON.parse(embStr);
        if (Array.isArray(vector) && vector.length > 0) {
          const sim = cosineSimilarity(queryVector, vector);
          similarities.push({ key: key.name, similarity: sim });
        }
      }
    } catch (err) {
      console.error(`Error calculando similitud para ${key.name}:`, err);
    }
  }

  // Ordenar de mayor a menor similitud
  similarities.sort((a, b) => b.similarity - a.similarity);

  // Seleccionar los mejores 3
  const topDocs = similarities.slice(0, 3);
  
  let context = "";
  let filesIncluded = 0;

  for (const item of topDocs) {
    // Aceptamos documentos con similitud razonable (> 0.35)
    if (item.similarity > 0.35) {
      const fileContent = await env.AIZPRUA_WIKI_KV.get(item.key);
      if (fileContent) {
        const fileNameClean = item.key.split('/').pop()?.replace('.md', '') || item.key;
        context += `\n--- Tema/Documento: ${fileNameClean} (Similitud: ${(item.similarity * 100).toFixed(1)}%) ---\n${fileContent}\n`;
        filesIncluded++;
      }
    }
  }

  // Si no se incluyeron documentos con buena afinidad semántica, caemos a búsqueda clásica por palabras clave
  if (filesIncluded === 0) {
    return getRelevantContextKeywordFallback(env, query, docKeys);
  }

  return context;
}

/**
 * Verifica si es un usuario nuevo en la base de datos y, de ser así, alerta al administrador.
 */
async function checkAndAlertAdmin(env: Env, userId: number, username: string, firstName: string, lastName: string): Promise<void> {
  const userKey = `user_seen:${userId}`;
  const alreadySeen = await env.AIZPRUA_WIKI_KV.get(userKey);
  
  if (!alreadySeen) {
    // Registrar al usuario en KV
    await env.AIZPRUA_WIKI_KV.put(userKey, "true");
    
    // Si no es el propio administrador, enviamos la alerta
    if (userId.toString() !== env.ADMIN_TELEGRAM_ID) {
      const alertMsg = `🚨 *Nuevo Usuario en el Bot!*\n\n*Nombre:* ${firstName} ${lastName}\n*Usuario:* ${username ? `@${username}` : "_No tiene_"}\n*ID:* \`${userId}\``;
      await sendTelegramMessage(env, parseInt(env.ADMIN_TELEGRAM_ID), alertMsg);
    }
  }
}

/**
 * Obtiene el historial de chat guardado para la sesión.
 */
async function getChatHistory(env: Env, chatId: number): Promise<{role: "user" | "model", text: string}[]> {
  const historyKey = `chat_history:${chatId}`;
  const historyData = await env.AIZPRUA_WIKI_KV.get(historyKey);
  if (!historyData) return [];
  try {
    return JSON.parse(historyData);
  } catch {
    return [];
  }
}

/**
 * Guarda el historial de chat con una expiración de 30 minutos (1800 segundos).
 */
async function saveChatHistory(env: Env, chatId: number, history: {role: "user" | "model", text: string}[]): Promise<void> {
  const historyKey = `chat_history:${chatId}`;
  await env.AIZPRUA_WIKI_KV.put(historyKey, JSON.stringify(history), { expirationTtl: 1800 });
}

  /**
   * Lee la base de conocimiento desde Cloudflare KV, arma el contexto y llama al modelo de IA configurado.
   * Soporta 3 modos: 'auto' (Gemini → OpenRouter → Cloudflare AI), 'gemini' (forzado) y 'llama' (forzado).
   */
async function handleUserQuery(env: Env, chatId: number, query: string): Promise<void> {
  await sendTelegramTyping(env, chatId);

  // 1. Listar todas las llaves en KV
  const list = await env.AIZPRUA_WIKI_KV.list();
  
  if (list.keys.length === 0) {
    await sendTelegramMessage(
      env, 
      chatId, 
      "La base de conocimiento está vacía. Por favor, pídele al administrador que ejecute `/sync` para cargar los datos."
    );
    return;
  }

  // 2. Obtener contexto optimizado y filtrado
  const kbContext = await getRelevantContext(env, query, list);

  // 3. Prompt de sistema con las reglas de Aizprua S.E.
  const systemPrompt = `Eres el asistente virtual oficial de "Aizprua S.E." (Aizprua Servicios Especiales). Tu comportamiento debe ser sumamente profesional, respetuoso y formal.

INSTRUCCIÓN CRÍTICA DE SEGURIDAD:
Tu conocimiento está estrictamente limitado a la información contenida en la "Base de conocimiento de la empresa" provista abajo.
- Si la información o respuesta a la pregunta del usuario NO está detallada explícitamente en la base de conocimiento, debes responder formalmente indicando que no dispones de ese detalle en tus registros y sugerir contactar a un asesor humano.
- Está terminantemente PROHIBIDO inventar, asumir, deducir o especular sobre cualquier dato (precios, leyes, requisitos, nombres, etc.) que no figure textualmente en los documentos provistos.

Directrices de comunicación:
1. Utilice un tono profesional, corporativo, formal y de absoluto respeto (use el trato de "usted" o estilo corporativo formal).
2. Mantenga sus respuestas estructuradas, legibles y claras. Evite el uso excesivo de emojis (use máximo uno o dos solo si es pertinente para facilitar la lectura).
3. Si el usuario pregunta precios o paquetes de servicio, limítese estrictamente a lo indicado en los documentos de paquetes.
4. IMPORTANTE: NUNCA uses asteriscos (*) para crear listas o viñetas. Usa siempre guiones (-). Los asteriscos solo pueden usarse para **negritas** y deben cerrarse correctamente.

Base de conocimiento de la empresa:
${kbContext}`;

  // 4. Obtener y actualizar historial de chat
  const history = await getChatHistory(env, chatId);
  history.push({ role: "user", text: query });
  
  if (history.length > 6) {
    history.splice(0, history.length - 6);
  }

  // Explicación Racional: Selección Dinámica de Modelo
  // Se lee el modo configurado ('auto', 'gemini', 'llama') desde KV.
  // En modo 'auto', si Gemini falló recientemente (cooldown activo de 5 min), se salta
  // Gemini y va directo a OpenRouter. Si OpenRouter falla, usa Cloudflare AI (Llama) como
  // último recurso. Al expirar el cooldown, Gemini se reintenta automáticamente.
  const activeModel = await env.AIZPRUA_WIKI_KV.get("bot:active_model") || "auto";
  const geminiCooldown = await env.AIZPRUA_WIKI_KV.get("gemini_cooldown");

  // Decidir qué modelos intentar según el modo activo
  const shouldTryGemini = activeModel === "gemini" || (activeModel === "auto" && !geminiCooldown);
  const shouldTryOpenRouter = (activeModel === "llama" || activeModel === "auto") && !!env.OPENROUTER_API_KEY;
  const shouldTryCloudflareAI = (activeModel === "llama" || activeModel === "auto");

  // --- Intentar Gemini (primario) ---
  if (shouldTryGemini) {
    try {
      const answer = await callGemini(env, systemPrompt, history);
      
      if (activeModel === "auto") {
        await env.AIZPRUA_WIKI_KV.delete("gemini_cooldown");
      }

      history.push({ role: "model", text: answer });
      await saveChatHistory(env, chatId, history);
      await sendTelegramMessage(env, chatId, `${answer}\n\n— 🤖 Gemini`);
      return;
    } catch (err: any) {
      const geminiErrMsg = err.message || err;
      console.error("Error al consultar Gemini:", geminiErrMsg);

      if (activeModel === "gemini") {
        await alertAdmin(env, "GEMINI_FAIL", geminiErrMsg, query, chatId);
        await sendTelegramMessage(env, chatId, "Lamento informarle que Gemini no está disponible en este momento. El administrador ha configurado este modelo como exclusivo. Por favor, intente de nuevo más tarde.");
        return;
      }

      await alertAdmin(env, "GEMINI_FAIL", geminiErrMsg, query, chatId);
      await env.AIZPRUA_WIKI_KV.put("gemini_cooldown", new Date().toISOString(), { expirationTtl: 300 });
    }
  }

  // --- Intentar OpenRouter (primer fallback) ---
  if (shouldTryOpenRouter) {
    try {
      const orAnswer = await callOpenRouter(env, systemPrompt, history);

      history.push({ role: "model", text: orAnswer });
      await saveChatHistory(env, chatId, history);
      await sendTelegramMessage(env, chatId, `${orAnswer}\n\n— 🧠 OpenRouter (Nemotron)`);
      return;
    } catch (fallbackErr: any) {
      console.error("Fallo en OpenRouter:", fallbackErr.message || fallbackErr);
      await alertAdmin(env, "OPENROUTER_FAIL", fallbackErr.message || fallbackErr, query, chatId);
    }
  }

  // --- Intentar Cloudflare AI (segundo fallback / último recurso) ---
  if (shouldTryCloudflareAI) {
    try {
      const cfAnswer = await callCloudflareAI(env, systemPrompt, history);

      history.push({ role: "model", text: cfAnswer });
      await saveChatHistory(env, chatId, history);
      await sendTelegramMessage(env, chatId, `${cfAnswer}\n\n— ☁️ Cloudflare AI (Llama)`);
      return;
    } catch (lastErr: any) {
      const lastErrMsg = lastErr.message || lastErr;
      console.error("Fallo en Cloudflare AI:", lastErrMsg);

      if (activeModel === "llama") {
        await alertAdmin(env, "CLOUDFLARE_AI_FAIL", lastErrMsg, query, chatId);
      } else {
        await alertAdmin(env, "TOTAL_FAIL", `Cloudflare AI falló con: "${lastErrMsg}"`, query, chatId);
      }
    }
  }

  await sendTelegramMessage(env, chatId, "Lamento informarle que actualmente nuestro sistema de consultas automatizadas está experimentando dificultades técnicas. Por favor, intente de nuevo en unos momentos o póngase en contacto con un asesor humano.");
}

/**
 * Llama al modelo Gemini y devuelve la respuesta como texto.
 * El modelo se configura via env.GEMINI_MODEL (default: gemini-2.5-flash).
 */
async function callGemini(env: Env, systemPrompt: string, history: {role: string, text: string}[]): Promise<string> {
  const modelsToTry = [
    env.GEMINI_MODEL,
    "gemini-2.5-flash"
  ].filter(Boolean) as string[];

  let lastError: Error | null = null;

  for (const model of modelsToTry) {
    try {
      return await tryGeminiModel(env, model, systemPrompt, history);
    } catch (err: any) {
      lastError = err;
      console.error(`Gemini model ${model} falló:`, err.message || err);
    }
  }

  throw lastError || new Error("Todos los modelos de Gemini fallaron");
}

async function tryGeminiModel(env: Env, model: string, systemPrompt: string, history: {role: string, text: string}[]): Promise<string> {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  
  const geminiContents = history.map(h => ({
    role: h.role,
    parts: [{ text: h.text }]
  }));

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: geminiContents,
    generationConfig: { temperature: 0.1, maxOutputTokens: 1200 }
  };

  const geminiRes = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    let cleanMsg = errText;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error && parsed.error.message) {
        cleanMsg = parsed.error.message;
      }
    } catch (e) {
      console.error("Error al parsear respuesta de error de Gemini:", e);
    }
    throw new Error(`Código ${geminiRes.status}: ${cleanMsg}`);
  }

  const resJson = await geminiRes.json() as any;
  return resJson.candidates?.[0]?.content?.parts?.[0]?.text || "No he podido estructurar una respuesta en este momento. Inténtalo de nuevo.";
}

/**
 * Llama a un modelo de OpenRouter (NVIDIA Nemotron) como respaldo.
 */
async function callOpenRouter(env: Env, systemPrompt: string, history: {role: string, text: string}[]): Promise<string> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY no configurada");
  }

  const model = "nvidia/nemotron-3-ultra-550b-a55b:free";

  const orMessages = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({
      role: h.role === "model" ? "assistant" : "user" as "user" | "assistant",
      content: h.text
    }))
  ];

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://aizprua-assistant.arubel68.workers.dev",
      "X-Title": "Aizprua S.E. Assistant"
    },
    body: JSON.stringify({
      model,
      messages: orMessages,
      max_tokens: 1200,
      temperature: 0.1
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter (${res.status}): ${errText}`);
  }

  const data = await res.json() as any;
  const answer = data?.choices?.[0]?.message?.content;

  if (!answer || !answer.trim()) {
    throw new Error("Respuesta vacía de OpenRouter");
  }

  return answer;
}

/**
 * Llama a Cloudflare Workers AI (Llama 3.1 8B) como último recurso.
 */
async function callCloudflareAI(env: Env, systemPrompt: string, history: {role: string, text: string}[]): Promise<string> {
  let systemPromptCf = systemPrompt + "\n\nREGLA ESTRICTA ADICIONAL: Eres un modelo de respaldo. TIENES ESTRICTAMENTE PROHIBIDO INVENTAR NOMBRES DE PRODUCTOS, MARCAS, LEYES O DATOS QUE NO ESTÉN EN LA BASE DE CONOCIMIENTO. Si la información no está, responde ÚNICAMENTE: 'No dispongo de esa información en mis registros, por favor contacte a un asesor humano.'";
  if (systemPromptCf.length > 6000) {
    systemPromptCf = systemPrompt.substring(0, 6000) + "\n\n[Contexto truncado por límites del modelo de respaldo]";
  }

  const messages = [
    { role: "system", content: systemPromptCf },
    ...history.map((h, index) => {
      let content = h.text;
      if (index === history.length - 1 && h.role !== "model") {
        content += "\n\n[RECORDATORIO OBLIGATORIO DEL SISTEMA: Usa siempre guiones (-) para listas, NUNCA asteriscos (*). TIENES ESTRICTAMENTE PROHIBIDO inventar datos, enlaces o sugerencias que no estén en tu base de conocimiento corporativa. Si no lo sabes, di 'No dispongo de esa información.']";
      }
      return { role: h.role === "model" ? "assistant" : "user", content };
    })
  ];

  const res = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages,
    max_tokens: 1200,
    temperature: 0.1
  }) as any;

  let answer = "";
  if (typeof res === "string") {
    answer = res;
  } else if (res && typeof res === "object") {
    answer = res.response || res.text || res.result?.response || "";
  }

  if (!answer.trim()) {
    throw new Error("Respuesta vacía de Cloudflare AI");
  }

  return answer;
}

/**
 * Envía una alerta estructurada al administrador de Telegram si ocurre un fallo.
 * Cuenta con un mecanismo de cooldown de 10 minutos por tipo de error para evitar spam.
 */
async function alertAdmin(env: Env, errorType: string, errorMsg: string, query?: string, chatId?: number): Promise<void> {
  const cooldownKey = `alert_cooldown:${errorType}`;
  try {
    const hasCooldown = await env.AIZPRUA_WIKI_KV.get(cooldownKey);
    if (hasCooldown) {
      console.log(`[Alert Cooldown] Alerta omitida para tipo ${errorType}: ${errorMsg}`);
      return;
    }
    // Registrar cooldown por 10 minutos (600 segundos)
    await env.AIZPRUA_WIKI_KV.put(cooldownKey, "true", { expirationTtl: 600 });
  } catch (kvErr) {
    console.error("Error al acceder a KV para cooldown de alerta:", kvErr);
  }

  const emoji = errorType === "TOTAL_FAIL" ? "🔴" : "⚠️";
  const severity = errorType === "TOTAL_FAIL" ? "CRÍTICA" : "MEDIA";
  const component = errorType === "GEMINI_FAIL" ? "Gemini" 
                  : errorType === "OPENROUTER_FAIL" ? "OpenRouter (Nemotron)" 
                  : errorType === "CLOUDFLARE_AI_FAIL" ? "Cloudflare AI (Llama)" 
                  : errorType === "SYNC_FAIL" ? "Sincronizador GitHub" 
                  : "Sistema Completo";

  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  
  let alertMsg = `${emoji} *ALERTA: Fallo en el Bot (Severidad: ${severity})*\n`;
  alertMsg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  alertMsg += `📌 *Componente:* ${component}\n`;
  alertMsg += `⏰ *Hora:* ${dateStr}\n`;
  alertMsg += `📝 *Error:* ${errorMsg}\n`;
  
  if (chatId) {
    alertMsg += `👤 *Chat afectado:* ID \`${chatId}\`\n`;
  }
  if (query) {
    alertMsg += `💬 *Consulta:* "${query}"\n`;
  }
  alertMsg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  
  if (errorType === "GEMINI_FAIL") {
    alertMsg += `⚙️ *Acción:* Se activó OpenRouter como respaldo.`;
  } else if (errorType === "OPENROUTER_FAIL") {
    alertMsg += `⚙️ *Acción:* Se activó Cloudflare AI (Llama) como último recurso.`;
  } else if (errorType === "TOTAL_FAIL") {
    alertMsg += `⚙️ *Acción:* Se envió mensaje de disculpa. Requiere revisión.`;
  } else if (errorType === "SYNC_FAIL") {
    alertMsg += `⚙️ *Acción:* La wiki sigue operativa con los datos locales anteriores.`;
  }

  try {
    await sendTelegramMessage(env, parseInt(env.ADMIN_TELEGRAM_ID), alertMsg);
  } catch (telegramErr) {
    console.error("Error al enviar mensaje de alerta a Telegram:", telegramErr);
  }
}

/**
 * Corre pruebas de diagnóstico sobre Cloudflare KV, GitHub API, Gemini, OpenRouter y Cloudflare AI.
 */
async function runSystemDiagnostics(env: Env): Promise<string> {
  let report = `🏥 *Diagnóstico del Sistema*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  let overallStatus = "✅ Todo operativo";

  // 1. Validar Cloudflare KV
  let kvStatus = "✅ Operativo";
  try {
    await env.AIZPRUA_WIKI_KV.put("health_check_test", "ok");
    const val = await env.AIZPRUA_WIKI_KV.get("health_check_test");
    await env.AIZPRUA_WIKI_KV.delete("health_check_test");
    if (val !== "ok") throw new Error("Valor retornado incorrecto");
  } catch (err: any) {
    kvStatus = `❌ Fallo (${err.message || err})`;
    overallStatus = "⚠️ Atención requerida";
  }
  report += `💾 *Cloudflare KV:* ${kvStatus}\n`;

  // 2. Validar GitHub API (Conectividad y Token)
  let githubStatus = "✅ Conectado (token válido)";
  try {
    const url = "https://api.github.com/repos/arubel86/Aizpruase-Documentos-Tramites";
    const res = await fetch(url, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "User-Agent": "Cloudflare-Worker-Telegram-Bot",
        "Accept": "application/vnd.github.v3+json"
      }
    });
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }
  } catch (err: any) {
    githubStatus = `❌ Error (${err.message || err})`;
    overallStatus = "⚠️ Atención requerida";
  }
  report += `🐙 *GitHub API:* ${githubStatus}\n`;

  // 3. Validar Gemini API
  const geminiModel = env.GEMINI_MODEL || "gemini-2.5-flash";
  let geminiStatus = "✅ Respondiendo";
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hola" }] }]
      })
    });
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }
  } catch (err: any) {
    geminiStatus = `❌ Error (${err.message || err})`;
    overallStatus = "⚠️ Atención requerida";
  }
  report += `🤖 *Gemini (${geminiModel}):* ${geminiStatus}\n`;

  // 4. Validar OpenRouter (Nemotron) Backup
  let orStatus = env.OPENROUTER_API_KEY ? "⏳ Probando..." : "⏸️ No configurado";
  if (env.OPENROUTER_API_KEY) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://aizprua-assistant.arubel68.workers.dev",
          "X-Title": "Aizprua S.E. Assistant"
        },
        body: JSON.stringify({
          model: "nvidia/nemotron-3-ultra-550b-a55b:free",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5
        })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Status ${res.status}: ${errText}`);
      }
      orStatus = "✅ Respondiendo";
    } catch (err: any) {
      orStatus = `⚠️ Error (${err.message || err})`;
      if (overallStatus === "✅ Todo operativo") {
        overallStatus = "⚠️ Backup no disponible";
      }
    }
  }
  report += `🧠 *OpenRouter (Nemotron):* ${orStatus}\n`;

  // 5. Validar Cloudflare AI (Llama) como último recurso
  let cfAIStatus = "✅ Respondiendo";
  try {
    const cfRes = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 5
    }) as any;
    if (!cfRes || (!cfRes.response && !cfRes.text)) {
      throw new Error("Respuesta vacía");
    }
  } catch (err: any) {
    cfAIStatus = `⚠️ Error (${err.message || err})`;
    if (overallStatus === "✅ Todo operativo") {
      overallStatus = "⚠️ Backup Cloudflare AI no disponible";
    }
  }
  report += `☁️ *Cloudflare AI (Llama):* ${cfAIStatus}\n`;

  // 5. Contar documentos
  try {
    const list = await env.AIZPRUA_WIKI_KV.list();
    const docCount = list.keys.filter(k => k.name.endsWith(".md") && !k.name.startsWith("embedding:")).length;
    report += `📚 *Base de Conocimiento:* ${docCount} documentos cargados\n`;
  } catch (err: any) {
    report += `📚 *Base de Conocimiento:* Error al listar\n`;
  }

  report += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `*Estado general:* ${overallStatus}`;
  
  return report;
}

/**
 * Helper para dividir texto de manera inteligente sin cortar palabras a la mitad.
 */
function splitText(text: string, maxLength: number = 4000): string[] {
  const chunks: string[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    if (text.length - currentIndex <= maxLength) {
      chunks.push(text.substring(currentIndex));
      break;
    }

    let splitIndex = text.lastIndexOf("\n", currentIndex + maxLength);
    if (splitIndex <= currentIndex) {
      splitIndex = text.lastIndexOf(" ", currentIndex + maxLength);
    }
    if (splitIndex <= currentIndex) {
      splitIndex = currentIndex + maxLength;
    }

    chunks.push(text.substring(currentIndex, splitIndex));
    currentIndex = splitIndex;
    
    while (currentIndex < text.length && /\s/.test(text[currentIndex])) {
      currentIndex++;
    }
  }

  return chunks;
}

/**
 * Envía la acción de chat de tipo "typing" a la API de Telegram.
 */
async function sendTelegramTyping(env: Env, chatId: number): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        action: "typing"
      })
    });
  } catch (err) {
    console.error("Error al enviar chat action de Telegram:", err);
  }
}

/**
 * Genera el vector de embedding para un texto dado utilizando Workers AI de Cloudflare.
 */
async function generateEmbedding(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  // Truncar para no exceder los límites del modelo
  const cleanText = text.substring(0, 2000).replace(/\r?\n/g, " ").trim();
  if (!cleanText) return null;
  
  const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [cleanText]
  }) as any;
  
  if (response && response.data) {
    if (Array.isArray(response.data[0])) {
      return response.data[0];
    } else if (Array.isArray(response.data)) {
      return response.data;
    }
  }
  return null;
}

/**
 * Calcula la similitud de coseno entre dos vectores numéricos.
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Búsqueda clásica por palabras clave (fallback cuando falla embeddings o no hay coincidencias semánticas).
 */
async function getRelevantContextKeywordFallback(env: Env, query: string, docKeys: any[]): Promise<string> {
  const stopWords = new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "y", "o", "e", "u", "a", "en", "para", "por", "con", "sin", "sobre", "que", "es", "son", "se", "lo", "como", "cual", "cuales", "como", "donde", "cuando", "quien", "cuanto", "cuantos"]);
  
  const keywords = query.toLowerCase()
    .replace(/[¿?¡!.,;:#()]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));

  let context = "";
  let filesIncluded = 0;

  for (const key of docKeys) {
    const fileContent = await env.AIZPRUA_WIKI_KV.get(key.name);
    if (!fileContent) continue;

    const contentLower = fileContent.toLowerCase();
    const fileNameLower = key.name.toLowerCase();
    
    const isMatch = keywords.some(keyword => fileNameLower.includes(keyword) || contentLower.includes(keyword));
    const isIndex = key.name.endsWith("index.md");

    if (isMatch || isIndex) {
      const fileNameClean = key.name.split('/').pop()?.replace('.md', '') || key.name;
      context += `\n--- Tema/Documento: ${fileNameClean} ---\n${fileContent}\n`;
      filesIncluded++;
    }
  }

  // Si no coincide casi nada, incluimos por defecto los primeros 5 documentos
  if (filesIncluded <= 1) {
    context = "";
    const limit = Math.min(docKeys.length, 5);
    for (let i = 0; i < limit; i++) {
      const key = docKeys[i];
      const fileContent = await env.AIZPRUA_WIKI_KV.get(key.name);
      if (fileContent) {
        const fileNameClean = key.name.split('/').pop()?.replace('.md', '') || key.name;
        context += `\n--- Tema/Documento: ${fileNameClean} ---\n${fileContent}\n`;
      }
    }
  }

  return context;
}
