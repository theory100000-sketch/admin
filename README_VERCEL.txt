THUNDER ELITE LEAGUE - DESPLIEGUE EN VERCEL
===========================================

1. Sube todos los archivos de este ZIP a un repositorio de GitHub.
2. En Vercel, pulsa Add New > Project e importa el repositorio.
3. Vercel detectará la aplicación Express automáticamente.
4. No configures Build Command ni Output Directory manualmente: vercel.json ya lo prepara.
5. Añade estas variables en Settings > Environment Variables:

   WEB_SESSION_SECRET=una_clave_larga_y_aleatoria
   WEB_ADMIN_PASSWORD=tu_contraseña_admin
   ADMIN_EMAIL=roleplayserver007@gmail.com

   Para login con Discord:
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   DISCORD_REDIRECT_URI=https://TU-DOMINIO.vercel.app/auth/discord/callback

   Para el formulario de contacto:
   DISCORD_CONTACT_WEBHOOK_URL=...

6. En Discord Developer Portal, añade exactamente el mismo Redirect URI.
7. Haz Redeploy después de añadir o cambiar variables.

PERSISTENCIA DEL PANEL (MUY RECOMENDADA)
----------------------------------------
Vercel no permite guardar cambios de forma permanente en data.json dentro de la función.
Este proyecto ya incluye compatibilidad con Upstash Redis:

1. Abre el proyecto en Vercel.
2. Ve a Storage o Marketplace.
3. Conecta una base Upstash Redis al proyecto.
4. Comprueba que Vercel añadió:
   UPSTASH_REDIS_REST_URL
   UPSTASH_REDIS_REST_TOKEN
5. Haz Redeploy.

Sin Upstash, la web pública y las API funcionarán, pero los cambios hechos desde el panel
solo serán temporales y pueden perderse al cambiar de instancia o desplegar de nuevo.

BOT DE DISCORD
--------------
El bot no se ejecuta dentro de Vercel porque necesita un proceso permanente.
El archivo discord-bot.js se conserva para alojarlo por separado en Railway, Render,
VPS u otro servicio de procesos persistentes.

SINCRONIZACIÓN DEL BOT CON LA WEB
---------------------------------
Si alojas discord-bot.js en Railway, Render o un VPS, configura allí las MISMAS variables:
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
TEL_REDIS_PREFIX

Así, los cambios hechos por comandos de Discord y los cambios del panel de Vercel compartirán data.json.

CORRECCIÓN DE RUTA PRINCIPAL
----------------------------
El archivo vercel.json incluye una reescritura de / hacia /index.html.
Es necesaria porque Vercel convierte server.js en una función Express y
express.static() no sirve los archivos públicos dentro de esa función.
