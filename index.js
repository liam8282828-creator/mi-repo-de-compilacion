require('dotenv').config();

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

// ─── Validar variables de entorno al arrancar ────────────────────────────────
const REQUIRED_VARS = ['TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`❌ Falta la variable de entorno: ${v}`);
    console.error(`   Copia .env.example a .env y rellena los valores.`);
    process.exit(1);
  }
}

const GITHUB_OWNER        = process.env.GITHUB_OWNER;
const GITHUB_REPO         = process.env.GITHUB_REPO;
const GITHUB_WORKFLOW     = process.env.GITHUB_WORKFLOW_FILE || 'compile.yml';
const DOTNET_VERSION      = process.env.DOTNET_VERSION || '8.0';
const MAX_ZIP_MB          = 50;
const POLL_INTERVAL_MS    = 30_000;  // 30 segundos entre consultas
const MAX_WAIT_MINUTES    = 60;

// ─── Cliente de la API de GitHub ────────────────────────────────────────────
const gh = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

// ─── Bot de Telegram ─────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// /start
bot.start((ctx) => {
  ctx.replyWithMarkdown(
    `🔨 *iOS Cloud Compiler Bot*\n\n` +
    `Convierte tu proyecto *C# / Avalonia UI* en un archivo *.ipa* usando runners ` +
    `macOS de GitHub Actions — completamente gratis.\n\n` +
    `*¿Cómo funciona?*\n` +
    `1️⃣ Comprime tu proyecto en un *.zip*\n` +
    `2️⃣ Envíamelo aquí por Telegram\n` +
    `3️⃣ Lo subo a GitHub y lanzo la compilación en macOS\n` +
    `4️⃣ En 5–15 minutos recibirás el *.ipa* directamente aquí\n\n` +
    `*Requisitos del proyecto:*\n` +
    `• .NET ${DOTNET_VERSION} o superior\n` +
    `• Proyecto Avalonia UI (C#)\n` +
    `• El .csproj en la raíz o en una subcarpeta\n\n` +
    `Envía tu *.zip* cuando estés listo ✌️`
  );
});

// /help
bot.help((ctx) => {
  ctx.replyWithMarkdown(
    `*Comandos disponibles:*\n\n` +
    `/start — Bienvenida e instrucciones\n` +
    `/help  — Mostrar esta ayuda\n\n` +
    `Para compilar: envía un archivo *.zip* con tu proyecto C#/Avalonia directamente al chat.`
  );
});

// ─── Recepción del ZIP ───────────────────────────────────────────────────────
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;

  if (!doc.file_name || !doc.file_name.toLowerCase().endsWith('.zip')) {
    return ctx.reply('❌ Por favor envía un archivo .zip con tu código fuente.');
  }

  if (doc.file_size > MAX_ZIP_MB * 1024 * 1024) {
    return ctx.reply(`❌ El archivo supera el límite de ${MAX_ZIP_MB} MB.`);
  }

  const statusMsg = await ctx.replyWithMarkdown(
    `📦 *Archivo recibido:* \`${doc.file_name}\`\n\n⏳ Iniciando proceso...`
  );

  const edit = (text) =>
    ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }).catch(() => {});

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-'));

  try {
    // 1. Descargar el ZIP de Telegram
    await edit('📥 *Descargando ZIP de Telegram...*');
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const zipPath = path.join(tmpDir, doc.file_name);
    await downloadFile(fileLink.href, zipPath);

    // 2. Subir a GitHub como release asset temporal
    await edit('☁️ *Subiendo código a GitHub...*');
    const { releaseId, assetId } = await uploadToGitHubRelease(zipPath, doc.file_name);

    // 3. Disparar workflow_dispatch
    await edit('🚀 *Lanzando compilación en GitHub Actions (runner macOS)...*');
    await triggerWorkflow(assetId, doc.file_name.replace('.zip', ''));

    // 4. Obtener el ID del run recién creado
    await sleep(6000);
    const runId = await getLatestRunId();
    const runUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`;

    await edit(
      `🔵 *Compilando en macOS...*\n\n` +
      `🆔 Run: \`${runId}\`\n` +
      `⏱ Tiempo estimado: 5–15 minutos\n\n` +
      `[Ver progreso en GitHub Actions](${runUrl})\n\n` +
      `_Te avisaré cuando termine._`
    );

    // 5. Esperar a que termine (polling)
    const conclusion = await pollUntilComplete(runId, runUrl, edit);

    if (conclusion === 'success') {
      // 6. Descargar el artefacto (.ipa)
      await edit('✅ *¡Compilación exitosa!* Descargando el .ipa...');
      const ipaPath = await downloadArtifact(runId, tmpDir);

      // 7. Enviar el .ipa al usuario
      await ctx.replyWithDocument(
        { source: ipaPath, filename: path.basename(ipaPath) },
        {
          caption:
            `✅ *¡Tu .ipa está listo!*\n` +
            `📦 Origen: \`${doc.file_name}\`\n` +
            `🔗 [Run de GitHub Actions](${runUrl})`,
          parse_mode: 'Markdown',
        }
      );

      await edit(`✅ *Compilación completada*\n\nEl archivo .ipa fue enviado arriba. ¡Listo!`);
    } else if (conclusion === 'timed_out') {
      await edit(
        `⏰ *Tiempo de espera agotado*\n\n` +
        `La compilación tardó más de ${MAX_WAIT_MINUTES} minutos.\n` +
        `[Revisa el estado en GitHub Actions](${runUrl})`
      );
    } else {
      await edit(
        `❌ *La compilación falló*\n\n` +
        `Resultado: \`${conclusion}\`\n` +
        `[Ver logs en GitHub Actions](${runUrl})\n\n` +
        `*Sugerencias:*\n` +
        `• Asegúrate de que el proyecto compile con \`dotnet publish -c Release -r ios-arm64\`\n` +
        `• Revisa que el .csproj esté en la raíz o subcarpeta del ZIP`
      );
    }

    // Limpiar el release temporal
    await cleanupRelease(releaseId);

  } catch (err) {
    console.error('[ERROR]', err.message);
    await edit(`❌ *Error inesperado:*\n\`${err.message}\``);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── FUNCIONES DE GITHUB ─────────────────────────────────────────────────────

/** Descarga un archivo desde una URL a un path local */
async function downloadFile(url, destPath) {
  const response = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

/** Sube el ZIP como asset a un release temporal de GitHub */
async function uploadToGitHubRelease(zipPath, fileName) {
  // Crear un release borrador (draft) como área de staging
  const releaseRes = await gh.post(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`, {
    tag_name: `staging-${Date.now()}`,
    name: 'Staging — compilación iOS',
    draft: true,
    prerelease: true,
    body: 'Release temporal para compilación iOS. Se borrará automáticamente.',
  });

  const releaseId = releaseRes.data.id;
  const uploadUrl = `https://uploads.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;

  const fileBuffer = fs.readFileSync(zipPath);
  const assetRes = await axios.post(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/zip',
      'Content-Length': String(fileBuffer.length),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return { releaseId, assetId: assetRes.data.id };
}

/** Dispara el workflow de GitHub Actions */
async function triggerWorkflow(assetId, projectName) {
  await gh.post(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      ref: 'main',
      inputs: {
        asset_id: String(assetId),
        project_name: projectName,
        dotnet_version: DOTNET_VERSION,
      },
    }
  );
}

/** Obtiene el ID del run más reciente de workflow_dispatch */
async function getLatestRunId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs`, {
      params: { per_page: 5, event: 'workflow_dispatch' },
    });
    const run = res.data.workflow_runs[0];
    if (run) return run.id;
    await sleep(3000);
  }
  throw new Error('No se encontró el run de GitHub Actions. Verifica que el workflow esté en la rama main.');
}

/** Hace polling hasta que el run termine */
async function pollUntilComplete(runId, runUrl, editFn) {
  const deadline = Date.now() + MAX_WAIT_MINUTES * 60 * 1000;
  let elapsed = 0;

  while (Date.now() < deadline) {
    const res = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`);
    const run = res.data;

    if (run.status === 'completed') {
      return run.conclusion; // 'success' | 'failure' | 'cancelled' | etc.
    }

    elapsed += POLL_INTERVAL_MS / 1000;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    await editFn(
      `🔵 *Compilando en macOS...*\n\n` +
      `🆔 Run: \`${runId}\`\n` +
      `⏱ Tiempo transcurrido: ${elapsedStr}\n` +
      `📊 Estado: \`${run.status}\`\n\n` +
      `[Ver progreso en GitHub Actions](${runUrl})\n\n` +
      `_Verificando cada 30 segundos..._`
    );

    await sleep(POLL_INTERVAL_MS);
  }

  return 'timed_out';
}

/** Descarga el .ipa desde los artefactos del run */
async function downloadArtifact(runId, destDir) {
  // Listar artefactos del run
  const artifactsRes = await gh.get(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/artifacts`
  );

  const artifact = artifactsRes.data.artifacts[0];
  if (!artifact) throw new Error('No se encontraron artefactos en el run. La compilación pudo haber fallado silenciosamente.');

  // Descargar el ZIP del artefacto (GitHub envuelve el .ipa en un ZIP)
  const downloadRes = await gh.get(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`,
    { responseType: 'arraybuffer', maxRedirects: 10, maxContentLength: Infinity }
  );

  const artifactZipPath = path.join(destDir, 'artifact.zip');
  fs.writeFileSync(artifactZipPath, Buffer.from(downloadRes.data));

  // Extraer el .ipa del ZIP del artefacto
  const zip = new AdmZip(artifactZipPath);
  const ipaEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.ipa'));

  if (!ipaEntry) throw new Error('No se encontró un archivo .ipa dentro del artefacto de GitHub Actions.');

  const ipaPath = path.join(destDir, path.basename(ipaEntry.entryName));
  fs.writeFileSync(ipaPath, ipaEntry.getData());

  return ipaPath;
}

/** Borra el release de staging (limpieza) */
async function cleanupRelease(releaseId) {
  try {
    const r = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${releaseId}`);
    const tag = r.data.tag_name;
    await gh.delete(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${releaseId}`);
    await gh.delete(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/tags/${tag}`);
  } catch (e) {
    console.warn('[WARN] No se pudo limpiar el release de staging:', e.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ARRANCAR BOT ────────────────────────────────────────────────────────────
bot
  .launch()
  .then(() => {
    console.log('\n✅ iOS Compiler Bot iniciado correctamente');
    console.log('──────────────────────────────────────────');
    console.log(`📋 GitHub Owner : ${GITHUB_OWNER}`);
    console.log(`📁 GitHub Repo  : ${GITHUB_REPO}`);
    console.log(`⚙️  Workflow     : ${GITHUB_WORKFLOW}`);
    console.log(`🔧 .NET version : ${DOTNET_VERSION}`);
    console.log('──────────────────────────────────────────');
    console.log('Bot escuchando mensajes... (Ctrl+C para detener)\n');
  })
  .catch((err) => {
    console.error('❌ Error al iniciar el bot:', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
