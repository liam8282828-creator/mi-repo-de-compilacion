# 🔨 iOS Cloud Compiler Bot

Bot de Telegram que compila proyectos **C# / Avalonia UI** en archivos **.ipa** usando runners macOS gratuitos de GitHub Actions.

## Cómo funciona

```
Tú (Telegram)          Bot (Node.js)           GitHub Actions (macOS)
──────────────         ──────────────          ──────────────────────
Envía .zip    ──────►  Sube a release  ──────► Instala .NET + iOS SDK
                       Dispara workflow         Compila con dotnet publish
Recibe .ipa   ◄──────  Descarga .ipa  ◄──────  Sube .ipa como artefacto
```

## Estructura del proyecto

```
telegram-ios-compiler/
├── index.js                        ← Bot principal (Node.js + Telegraf)
├── package.json                    ← Dependencias
├── .env.example                    ← Plantilla de variables de entorno
├── .gitignore
├── README.md
└── .github/
    └── workflows/
        └── compile.yml             ← Workflow de GitHub Actions (macOS)
```

---

## Instalación y puesta en marcha

### Requisitos previos

- [Node.js](https://nodejs.org/) v18 o superior
- [VS Code](https://code.visualstudio.com/) (recomendado)
- Una cuenta de GitHub
- La app de Telegram

---

### Paso 1 — Crear el bot en Telegram

1. Abre Telegram y busca **@BotFather**
2. Envía `/newbot`
3. Elige un nombre (ej: *iOS Compiler*) y un @username (ej: `micompilador_bot`)
4. BotFather te dará un token como:
   ```
   123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   Guárdalo — lo necesitarás en el `.env`.

---

### Paso 2 — Preparar el repositorio de GitHub Actions

Este es el repo que actuará como "servidor de compilación". Puede ser **público o privado**.

1. Crea un repositorio nuevo en GitHub (ej: `mi-compilador-ios`)
2. Copia la carpeta `.github/workflows/compile.yml` de este proyecto a ese repositorio
3. Haz commit y push a la rama `main`

```bash
# Desde la carpeta del repositorio de compilación
mkdir -p .github/workflows
cp /ruta/a/telegram-ios-compiler/.github/workflows/compile.yml .github/workflows/
git add .github/workflows/compile.yml
git commit -m "Agregar workflow de compilación iOS"
git push origin main
```

---

### Paso 3 — Crear un Personal Access Token (PAT) de GitHub

El bot necesita un token con estos permisos:

- ✅ `repo` — acceso completo al repositorio (para subir releases y assets)
- ✅ `workflow` — para disparar GitHub Actions

1. Ve a [github.com/settings/tokens](https://github.com/settings/tokens)
2. Haz clic en **"Generate new token (classic)"**
3. Marca `repo` y `workflow`
4. Copia el token generado (solo se muestra una vez)

---

### Paso 4 — Configurar las variables de entorno

1. Copia `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```

2. Abre `.env` en VS Code y rellena los valores:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:AAHxxxxxxxxxxxxxxxx
   GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
   GITHUB_OWNER=tu-usuario-de-github
   GITHUB_REPO=mi-compilador-ios
   GITHUB_WORKFLOW_FILE=compile.yml
   DOTNET_VERSION=8.0
   ```

---

### Paso 5 — Instalar dependencias y ejecutar

Abre la carpeta `telegram-ios-compiler` en VS Code y ejecuta en la terminal:

```bash
# Instalar dependencias
npm install

# Iniciar el bot
npm start
```

Deberías ver:
```
✅ iOS Compiler Bot iniciado correctamente
──────────────────────────────────────────
📋 GitHub Owner : tu-usuario
📁 GitHub Repo  : mi-compilador-ios
⚙️  Workflow     : compile.yml
🔧 .NET version : 8.0
──────────────────────────────────────────
Bot escuchando mensajes... (Ctrl+C para detener)
```

---

## Uso del bot

1. Abre tu bot en Telegram y envía `/start`
2. Comprime tu proyecto Avalonia UI en un `.zip`
3. Envía el `.zip` al chat del bot
4. Espera 5–15 minutos (el runner macOS de GitHub instala las herramientas y compila)
5. El bot te enviará el `.ipa` directamente en el chat

---

## Requisitos del proyecto C#/Avalonia

- .NET 8.0 o superior
- Tipo de proyecto: Avalonia UI (mobile/cross-platform)
- El archivo `.csproj` debe estar en la raíz del ZIP o en una subcarpeta
- No incluir carpetas `bin/` u `obj/` en el ZIP (son pesadas e innecesarias)

### Comprimir el proyecto correctamente

```bash
# macOS / Linux
cd /ruta/a/tu-proyecto
zip -r mi-proyecto.zip . -x "*/bin/*" -x "*/obj/*" -x "*/.git/*"

# Windows (PowerShell)
Compress-Archive -Path .\* -DestinationPath mi-proyecto.zip -CompressionLevel Optimal
```

---

## Notas importantes

- **El `.ipa` generado no está firmado** — para instalarlo en un dispositivo físico necesitas un certificado de desarrollador de Apple. Sin firma, sirve para distribución con herramientas como AltStore o para simulador.
- El bot guarda el ZIP en un **release draft temporal** en GitHub y lo borra automáticamente al terminar.
- El límite de tamaño del ZIP es **50 MB** (límite de Telegram para bots).
- Los artefactos de GitHub Actions se conservan **1 día** (suficiente para que el bot los descargue).

---

## Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `/start` | Bienvenida e instrucciones |
| `/help` | Mostrar ayuda |
| Enviar `.zip` | Iniciar compilación |
