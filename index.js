// ─── iOS Cloud Compiler Bot Definitivo ───────────────────────────────────────
require('dotenv').config();

const { Telegraf } = require('telegraf');
const axios        = require('axios');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const AdmZip       = require('adm-zip');

const REQUIRED_VARS = ['TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`❌ Falta la variable de entorno: ${v}`);
    process.exit(1);
  }
}

const GITHUB_OWNER       = process.env.GITHUB_OWNER;
const GITHUB_REPO        = process.env.GITHUB_REPO;
const GITHUB_WORKFLOW    = process.env.GITHUB_WORKFLOW_FILE || 'compile.yml';
const GITHUB_BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'main';
const DOTNET_VERSION     = process.env.DOTNET_VERSION || '8.0';
const MAX_ZIP_MB         = 95;           
const POLL_INTERVAL_MS   = 30_000;       
const MAX_WAIT_MINUTES   = 60;

const gh = axios.create({
  baseURL: 'https://github.com',
  headers: {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  maxBodyLength:   Infinity,
  maxContentLength: Infinity,
  timeout: 120_000,
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start((ctx) => {
  ctx.replyWithMarkdown(
    `🔨 *iOS Cloud Compiler Bot Corregido*\n\n` +
    `Envía tu archivo *.zip* cuando estés listo para compilar tu .ipa de Unity Assets ✌️`
  );
});

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;

  if (!doc.file_name || !doc.file_name.toLowerCase().endsWith('.zip')) {
    return ctx.reply('❌ Por favor envía un archivo .zip con tu código fuente.');
  }

  const sizeMb = (doc.file_size / (1024 * 1024)).toFixed(1);
  if (doc.file_size > MAX_ZIP_MB * 1024 * 1024) {
    return ctx.reply(`❌ El archivo supera el límite de ${MAX_ZIP_MB} MB.`);
  }

  const statusMsg = await ctx.replyWithMarkdown(`📦 *Archivo recibido:* \`${doc.file_name}\`\n\n⏳ Iniciando...`);

  const edit = (text) =>
    ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-'));
  const branchName = `bot-compile-${Date.now()}-${doc.file_id.slice(-6)}`;

  try {
    await edit(`📥 *Descargando ZIP de Telegram al servidor...*`);
    const zipPath = path.join(tmpDir, 'source.zip');

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    await downloadFileWithProgress(fileLink.href, zipPath);

    await edit(`☁️ *Subiendo código a la rama temporal de GitHub...*`);
    await uploadZipToBranch(zipPath, branchName);

    await edit(`🚀 *Lanzando compilación en GitHub Actions (runner macOS)...*`);
    const triggerTime = new Date();
    await triggerWorkflow(branchName);

    await sleep(5000); 
    const runId = await getLatestRunId(triggerTime);
    const runUrl = `https://github.com{GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`;

    await edit(`🔵 *Compilando en macOS...*\n\n🆔 Run: \`${runId}\`\n\n[Ver progreso en GitHub Actions](${runUrl})`);
    const conclusion = await pollUntilComplete(runId, runUrl, edit);

    if (conclusion === 'success') {
      await edit(`✅ *¡Compilación exitosa!* Descargando el .ipa...`);
      const ipaPath = await downloadArtifact(runId, tmpDir);

      await ctx.replyWithDocument({ source: ipaPath, filename: path.basename(ipaPath) }, {
        caption: `✅ *¡Tu .ipa está listo!*\n📦 Origen: \`${doc.file_name}\``,
        parse_mode: 'Markdown',
      });
      await edit(`✅ *Proceso completado.* ¡El archivo fue enviado arriba!`);
    } else {
      await edit(`❌ *La compilación falló en la Mac virtual*\n\nResultado: \`${conclusion}\`\n\n[Ver logs de error aquí](${runUrl})`);
    }

  } catch (err) {
    console.error('[ERROR]', err);
    await edit(`❌ *Error:* \n\n\`${err.message}\``);
  } finally {
    await cleanupBranch(branchName);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function downloadFileWithProgress(url, destPath) {
  const response = await axios.get(url, { responseType: 'stream', maxRedirects: 10, timeout: 120_000 });
  const writer = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function uploadZipToBranch(zipPath, branchName) {
  const zipBuffer = fs.readFileSync(zipPath);
  const zipBase64 = zipBuffer.toString('base64');

  const refRes = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${GITHUB_BASE_BRANCH}`);
  const baseSha = refRes.data.object.sha;

  const commitRes = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${baseSha}`);
  const baseTreeSha = commitRes.data.tree.sha;

  const blobRes = await gh.post(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, { content: zipBase64, encoding: 'base64' });
  const blobSha = blobRes.data.sha;

  const treeRes = await gh.post(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, {
    base_tree: baseTreeSha,
    tree: [{ path: 'source.zip', mode: '100644', type: 'blob', sha: blobSha }],
  });
  const newTreeSha = treeRes.data.sha;

  const newCommitRes = await gh.post(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
    message: `[bot] Upload source for iOS compilation`,
    tree:    newTreeSha,
    parents: [baseSha],
  });
  const newCommitSha = newCommitRes.data.sha;

  await gh.post(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: newCommitSha,
  });
}

async function triggerWorkflow(branchName) {
  await gh.post(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`, {
    ref: GITHUB_BASE_BRANCH,
    inputs: {
      branch_name: String(branchName),
      dotnet_version: String(DOTNET_VERSION)
    }
  });
}

async function getLatestRunId(afterTime) {
  const afterMs = afterTime.getTime();
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(4000);
    const res = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs`, { params: { per_page: 10, event: 'workflow_dispatch' } });
    const run = res.data.workflow_runs.find((r) => {
      const createdAt = new Date(r.created_at).getTime();
      return createdAt >= afterMs - 5000 && (r.path?.endsWith(GITHUB_WORKFLOW) || r.name === 'iOS Avalonia Compiler');
    });
    if (run) return run.id;
  }
  throw new Error(`No se encontró el run del workflow en GitHub Actions.`);
}

async function pollUntilComplete(runId, runUrl, editFn) {
  const deadline  = Date.now() + MAX_WAIT_MINUTES * 60 * 1000;
  let   elapsedMs = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    elapsedMs += POLL_INTERVAL_MS;
    let run;
    try {
      const res = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`);
      run = res.data;
    } catch (err) { continue; }
    if (run.status === 'completed') return run.conclusion;
    const mins = Math.floor(elapsedMs / 60000);
    const secs = Math.floor((elapsedMs % 60000) / 1000);
    const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    await editFn(`🔵 *Compilando en macOS...*\n\n🆔 Run: \`${runId}\`\n⏱ Tiempo transcurrido: ${elapsed}\n📊 Estado: \`${run.status}\`\n\n[Ver progreso en GitHub Actions](${runUrl})`);
  }
  return 'timed_out';
}

async function downloadArtifact(runId, destDir) {
  const artifactsRes = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/artifacts`);
  const artifact = artifactsRes.data.artifacts[0];
  if (!artifact) throw new Error(`No se encontraron artefactos subidos.`);
  
  const downloadRes = await gh.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`, { responseType: 'arraybuffer', maxRedirects: 10, maxContentLength: Infinity });
  const artifactZipPath = path.join(destDir, 'artifact.zip');
  fs.writeFileSync(artifactZipPath, Buffer.from(downloadRes.data));
  
  const zip = new AdmZip(artifactZipPath);
  const ipaEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.ipa'));
  if (!ipaEntry) throw new Error(`El artefacto no contiene un archivo .ipa.`);
  
  const ipaPath = path.join(destDir, path.basename(ipaEntry.entryName));
  fs.writeFileSync(ipaPath, ipaEntry.getData());
  return ipaPath;
}

async function cleanupBranch(branchName) {
  try {
    await gh.delete(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${branchName}`);
  } catch (e) {}
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

bot.launch().then(() => {
  console.log('\n✅ iOS Compiler Bot definitivo iniciado correctamente y escuchando...');
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
