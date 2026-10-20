# StudioMix Live

Tu propia plataforma de directos. Emites desde StudioMix (o OBS) y tu público
te ve en tu página web, con chat, contador de espectadores y, si quieres,
contraseña. Sin YouTube ni Twitch de por medio.

- **Poco retardo:** vídeo por WebRTC, unos **1,2–1,3 s** desde que cortas en
  StudioMix hasta la página del público, con sonido (medido en red local; por
  internet depende de la conexión).
- **Chat** con moderación: borrar mensajes, bloquear a alguien, vaciar el chat.
- **Público o privado:** activa una contraseña cuando quieras; al cambiarla,
  quien entró con la anterior tiene que escribir la nueva.
- **Panel de administración** con la dirección y la clave para StudioMix.
- **Seguro por diseño:** solo emite quien tiene la clave; el público nunca
  conecta directamente con el servidor de vídeo ni ve la clave; contraseñas
  guardadas con scrypt; cabeceras de seguridad estrictas.

Funciona con [MediaMTX](https://github.com/bluenviron/mediamtx) (licencia MIT),
que recibe la emisión y la reparte. Se descarga de sus releases oficiales al
instalar y se comprueba su suma SHA-256.

**Sonido:** StudioMix y OBS envían el audio en AAC, pero los navegadores solo
reproducen Opus por WebRTC. El servidor convierte únicamente el audio con
**FFmpeg** (el vídeo se copia tal cual, así que apenas usa CPU). Busca FFmpeg en
`ffmpegPath` de `data/config.json`, en la variable `FFMPEG_PATH`, en el `PATH`
o junto a StudioMix (`../studiomix`). Sin FFmpeg el público ve el vídeo sin
sonido y el panel lo avisa.

## Probarlo en tu equipo

Necesitas [Node.js](https://nodejs.org) 20 o superior.

1. Haz doble clic en **`iniciar.cmd`** (o ejecuta `node scripts/setup.mjs` y
   después `node server/index.js`). La primera vez descarga MediaMTX (~27 MB).
2. La consola muestra un **código de activación**. Abre
   `http://localhost:8080/admin`, escríbelo y elige tu contraseña de
   administrador.
3. En el panel verás el **servidor** y la **clave de emisión**. En StudioMix:
   Ajustes → Destinos → añade uno con esos datos y pulsa Emitir.
4. Tu público entra en `http://TU-IP:8080/` (la dirección exacta aparece en el
   panel, en «Enlace para el público»).

> En PowerShell, `npm start` puede fallar por la directiva de ejecución de
> scripts de Windows; usa `node server/index.js` o `iniciar.cmd`.

La primera vez, Windows puede preguntar por el cortafuegos: permite el acceso
en redes privadas para que otros equipos de tu red puedan verte.

## Ponerlo en internet

Para que te vea cualquiera, instálalo en un servidor (VPS) con Linux:

1. Instala Node.js 20+ y FFmpeg (`sudo apt install ffmpeg` en Debian/Ubuntu),
   `git clone` este repositorio, `node scripts/setup.mjs` y arráncalo como
   servicio (por ejemplo con systemd: `ExecStart=/usr/bin/node server/index.js`).
2. Abre en el cortafuegos del servidor:
   - **TCP 1935** (RTMP, para StudioMix) y **UDP 8890** (SRT, opcional).
   - **UDP y TCP 8189** (el vídeo WebRTC hacia el público).
   - **TCP 443** para la web (a través de HTTPS, siguiente punto).
3. Pon delante un proxy con **HTTPS**, por ejemplo [Caddy](https://caddyserver.com)
   (consigue el certificado solo):

   ```
   mi-directo.ejemplo.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   Sin HTTPS, las contraseñas viajarían sin cifrar.
4. En el panel, escribe tu dominio en **Dirección pública**: el vídeo WebRTC lo
   necesita para llegar al público desde fuera.

**Ancho de banda:** cada espectador recibe la emisión entera. A 4,5 Mb/s,
100 espectadores son unos 450 Mb/s de subida del servidor. Para públicos
grandes conviene un servicio de vídeo con CDN.

## Configuración

Todo se guarda en `data/config.json` (se crea al arrancar; no lo subas a
ningún sitio: contiene la clave de emisión). Puertos por defecto: web 8080,
RTMP 1935, SRT 8890, WebRTC 8189; se cambian en ese archivo. La carpeta de
datos puede cambiarse con la variable `STUDIOMIX_LIVE_DATA`.

## Desarrollo

```bash
node --test          # tests
node server/index.js # arrancar
```

- `server/index.js`: rutas HTTP, proxy WHEP hacia MediaMTX, panel y la
  autorización que MediaMTX consulta para cada emisión o reproducción.
- `server/mediamtx.js`: genera la configuración de MediaMTX y lo mantiene vivo.
- `server/ffmpeg.js`: busca FFmpeg y prepara la copia con audio Opus para el público.
- `server/chat.js`: chat y estado en vivo por Server-Sent Events.
- `server/config.js`, `server/sessions.js`: ajustes, contraseñas y cookies firmadas.
- `web/`: página del público (`index.html`) y panel (`admin.html`).

Sin dependencias de npm.

## Licencia

MIT. MediaMTX es de sus autores, con licencia MIT.
