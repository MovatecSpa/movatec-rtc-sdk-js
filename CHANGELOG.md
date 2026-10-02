# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es/1.1.0/). Versionado semántico.

## [1.5.0] - 2026-09-24
### Agregado
- **Asignación de números por empresa cliente.** Antes las empresas separaban la cartera pero
  compartían la bolsa de números; ahora cada una puede tener los suyos.
  - `POST /v1/tokens` acepta `accounts` como objetos: `{ id, label?, cli?[], default_cli? }`.
    Quien emite el token decide la asignación, y va firmada.
  - `callPhone(destino, { account })` resuelve el número de esa empresa solo.
  - `callPhone(destino, { account, from })` **fija** uno de los números de esa empresa; sin `from`,
    la plataforma rota dentro de su pool.
  - `rtc.accountsDetail()`, `rtc.account(id?)` y `rtc.allowedCli(account?)` para poblar el selector
    del CRM. El evento `connected` trae `accountsDetail`.
- Nueva causa `cli-no-pertenece-a-empresa` en `hangup`: el número existe, pero es de otra empresa.

### Seguridad
- **Se cierra el cruce de números entre carteras en el cliente.** Pedir un número de la empresa A
  con `account: "B"` lanza error antes de enviar el INVITE.
  ⚠️ Esto es defensa temprana, no la frontera: para que un front comprometido tampoco pueda hacerlo,
  falta que el borde revalide CLI↔empresa contra el token firmado (ver Pendiente).
- Un `default_cli` que apunte fuera del `cli` de su empresa se ignora (sería el mismo cruce).
- `account()`, `accountsDetail()` y `allowedCli()` devuelven **copias**: mutar lo que entrega el SDK ya no
  puede envenenar el pool de una empresa ni, con eso, colar su número en la cartera de otra.

### Seguridad operativa
- `__skipLocalCliCheck` (escape para probar el rechazo del borde) ahora emite un evento `warning`
  con código `LOCAL_CLI_CHECK_SKIPPED` y un `console.warn` en cada uso: ya no puede quedar activo
  en producción sin dejar rastro. Nuevo evento `warning` en `rtc.on()`.

### Corregido
- El número de presentación se normaliza igual que el destino: un CLI legítimo escrito
  `"+56 2 2222 2222"` ya no rebota contra la validación.
- Un `cli` mal formado en el token deja a esa empresa sin números propios (hereda el pool de la
  cuenta) en vez de tumbar `connect()`.

### Pendiente (lado plataforma, fuera de este repo)
- El borde debe: aceptar `accounts` con objetos en `POST /v1/tokens`, **revalidar que el CLI
  pertenezca a la empresa** contra el token firmado (responder `403` nombrando ambos, para que
  mapee a `cli-no-pertenece-a-empresa`) y entender `X-Movatec-Cli-Mode`. Sin eso, el aislamiento
  vive sólo en el navegador.
- Sin verificar contra el edge real: que un INVITE cruzado armado a mano reciba efectivamente `403`.

### Notas
- Compatible hacia atrás: `accounts` como lista de strings se comporta igual que en 1.4.0, y una
  empresa declarada sin `cli` hereda el pool de la cuenta.
- Requiere soporte del borde para la cabecera `X-Movatec-Cli-Mode` (`fixed` = respetar el número
  enviado, `pool` = rotar dentro del de la empresa). Si el borde la ignora, respeta el número
  enviado, que es el comportamiento conservador.

## [1.4.0] - 2026-09-23
### Agregado
- **Pool de números por empresa cliente.** Si tu cuenta gestiona carteras de varias empresas,
  cada una puede tener su propio conjunto de números y nunca comparte con otra.
  - `POST /v1/tokens` acepta `accounts: [...]` con las empresas que ese usuario puede gestionar.
    La primera es la que se usa cuando la llamada no indica ninguna.
  - `callPhone(destino, { account: "empresa-a" })` elige la cartera en esa llamada.
  - `rtc.accounts()` lista las habilitadas; `connected` trae `accounts` y `defaultAccount`.
- Nueva causa `empresa-no-habilitada` en `hangup`: la empresa pedida no está entre las del token.

### Seguridad
- La empresa viaja como cabecera pero **la plataforma sólo la acepta si está firmada en el token**.
  Verificado con un bundle manipulado: la llamada se rechaza en el borde con `403` en ~0,7 s y
  nunca sale a la red.

## [1.3.1] - 2026-09-22
### Corregido
- `outbound-ani` espera el número **confirmado por la red** (`fuente: "cdr"`) en lugar de emitir
  el del pool apenas está disponible. Es el número que realmente vio el destino y el que va a
  aparecer si devuelven el llamado; el del pool queda sólo como respaldo si el CDR no llega.

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
