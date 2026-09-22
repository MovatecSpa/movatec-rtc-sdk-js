# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es/1.1.0/). Versionado semántico.

## [1.3.0] - 2026-09-22
### Agregado
- `outbound-ani` ahora trae `aniPool` (el número que la plataforma eligió del pool del cliente
  para esa llamada) y `fuente` (`"cdr"` = confirmado por la red, `"pool"` = aún sin confirmar).
  Si `ani` y `aniPool` difieren, la terminación reescribió el número por su cuenta.
- El dato llega antes: la plataforma publica el número elegido al cursar la llamada, sin
  esperar el CDR.

## [1.2.0] - 2026-09-22
### Agregado
- Evento **`outbound-ani`**: el número que la plataforma presentó realmente al destino.
  El CLI que envía el navegador es sólo la entrada — la red puede reescribir el ANI (pool
  rotativo), así que el número que ve quien recibe no se conoce hasta que la llamada se cursa.
  Se resuelve solo unos segundos después de colgar (medido: ~5 s) y trae `ani`, `cliEnviado`,
  `destino`, `sipCode` y `callId`. Sirve para registrarlo junto a la gestión y reconocer la
  devolución del llamado.
- `call.outboundAni` (propiedad) y `call.resolveOutboundAni()` para pedirlo a mano.
- `resolveOutboundAni: false` en las opciones para desactivar la consulta automática.

### Notas
- Requiere el endpoint `GET /v1/rtc/calls/{call_id}` de la plataforma (ya desplegado).
- Sólo aplica a llamadas salientes a la red telefónica.

## [1.1.0] - 2026-09-22
### Agregado
- Evento `progress`: cada respuesta provisional de la red (`180`, `183`) con `sipCode`, `sipReason` y `earlyMedia`.
- Evento `calling`: el INVITE salió. Es lo que antes, incorrectamente, se emitía como `ringing`.
- **Tono de llamada local** mientras el destino timbra (WebAudio, 400 Hz con cadencia 1 s / 3 s).
  Se desactiva con `ringbackTone: false`. Si la red manda *early media* (183 con audio), se
  reproduce ese audio real y el tono local no suena.
- `hangup` ahora trae `cause` (causa de negocio), `causeText` (texto en español listo para pantalla)
  y `rang` (si alcanzó a timbrar). Ver `HangupCause` y `HANGUP_CAUSE_TEXT`.
- `sipCause(code, reason, rang)` exportada: traduce un código SIP a causa de negocio.
- `PhoneCall.hasRung`.

### Corregido
- **`ringing` era un falso positivo**: se emitía al enviar el INVITE (SIP.js `Establishing`), así que
  una llamada que la red descartaba igual aparecía "timbrando" para el operador. Ahora `ringing` se
  emite solo al recibir `180`/`183` reales del destino.
- `404 No routes` (prefijo/país no habilitado en la cuenta) se reporta como `destino-no-habilitado`
  y no como número inválido: la acción del operador es distinta.

### Cambios incompatibles
- Quien escuchara `ringing` para saber "se envió la llamada" debe escuchar `calling`.
  `ringing` ahora significa que el teléfono del destino está sonando de verdad.

## [1.0.0] - 2026-09-04
### Agregado
- `createRtc(token, options)`, `connect()` / `disconnect()`, reconexión automática con backoff.
- Llamadas salientes a la red telefónica: `callPhone(numero, { from })`, `mute`/`unmute`, `hangup`, `sendDTMF`, `hold`/`resume`.
- Llamadas entrantes al navegador (`incoming-webrtc-call` con `accept()` / `decline()`), incluidas llamadas entre usuarios de la misma cuenta (`callUser`).
- Calidad de red medida en el navegador (`network-quality`: RTT, jitter, pérdida, MOS estimado, puntaje 1-5) y reporte a la plataforma.
- Dispositivos de audio: enumerar, seleccionar micrófono y parlante (también en plena llamada), eventos de cambio y pérdida, nivel de micrófono.
- Bundles listos para navegador: ESM (`dist/rtc-sdk.browser.js`) e IIFE (`dist/rtc-sdk.iife.js`, global `MovatecRTC`).
### Limitaciones conocidas
- `transfer()` responde `transfer-failed` (501): la transferencia SIP requiere un B2BUA en el borde; disponible en una versión futura.
- Solo audio. Sin video, pantalla compartida ni salas.
