# Movatec RTC JavaScript SDK

SDK de voz WebRTC de [Movatec](https://www.movatec.cl) para integrar llamadas en tu CRM o aplicación web: llamadas salientes a la red telefónica, llamadas entrantes a tus DIDs directamente en el navegador y llamadas entre usuarios de tu cuenta. La API está pensada para que migrar desde `infobip-rtc-js` sea cambiar la importación.

### Introducción

Con este SDK cada usuario interno de tu plataforma habla y recibe llamadas desde el navegador, sin softphone ni extensión. Movatec hace de borde WebRTC/SIP (autenticación, control de fraude, TURN, transcodificación) y termina las llamadas en su red. Tu backend nunca expone credenciales SIP: pide un token de corta duración por usuario y el navegador lo usa.

```
Tu backend  ── API key ──▶  Movatec RTC API  ──▶ token por usuario
Tu web (SDK) ── token ────▶  Movatec RTC API  ──▶ credenciales efímeras + TURN
Tu web (SDK) ── WSS + SRTP ▶ borde Movatec ──▶ red telefónica / otros usuarios
```

### Requisitos

- Cuenta en Movatec RTC con una **API key** (la entrega Movatec al dar de alta tu cuenta) y al menos un **CLI** (número que presentas) autorizado.
- Sitio servido por **HTTPS** (el navegador exige contexto seguro para el micrófono).
- Salida desde los navegadores hacia `wss://rtc-edge.movatec.cl:443` y hacia `trun-dc01.movatec.cl` UDP/TCP 3478 y TCP 5349 (TURN). Con proxies corporativos restrictivos funciona por `turns:` TCP 5349.

### Primeros pasos

**1. Tu backend emite un token por usuario** (nunca desde el navegador; la API key es secreta):

```bash
curl -X POST https://rtc-api.movatec.cl/v1/tokens \
  -H "X-Api-Key: $MOVATEC_API_KEY" -H "Content-Type: application/json" \
  -d '{"identity":"agente.17","display_name":"Ana","ttl_seconds":3600,"capabilities":["outbound","inbound"]}'
```

Respuesta: `{ "token": "<JWT>", "expires_at": 1757000000, "identity": "agente.17", "tenant_id": "acme" }`. `identity` es el identificador estable del usuario en tu sistema. Opcionalmente puedes acotar `allowed_cli` a un subconjunto de tus CLIs.

**2. Tu web crea el cliente con ese token:**

```html
<script src="https://cdn.jsdelivr.net/npm/@movatec/rtc-sdk@1/dist/rtc-sdk.iife.js"></script>
<script>
  const rtc = MovatecRTC.createRtc(token, { apiBaseUrl: "https://rtc-api.movatec.cl" });
  rtc.on("connected", () => console.log("listo para llamar"));
  rtc.connect();
</script>
```

### Obtener el SDK

| Vía | Uso |
|---|---|
| npm | `npm i @movatec/rtc-sdk` → `import { createRtc } from "@movatec/rtc-sdk"` |
| CDN (global `MovatecRTC`) | `https://cdn.jsdelivr.net/npm/@movatec/rtc-sdk@1/dist/rtc-sdk.iife.js` |
| CDN (ESM) | `https://cdn.jsdelivr.net/npm/@movatec/rtc-sdk@1/dist/rtc-sdk.browser.js` |
| Releases de GitHub | bundles adjuntos a cada versión |

### Autenticación

- El token es un JWT firmado por Movatec. Lleva tu `tenant_id`, la `identity`, los CLIs permitidos y las capacidades (`outbound`, `inbound`). No contiene contraseñas.
- Al llamar a `connect()`, el SDK canjea el token por credenciales SIP y TURN **efímeras**, ligadas a esa sesión de navegador. Un token equivale a una pestaña activa: si abres una segunda con el mismo token, la primera pierde el registro.
- Cuando el token expira, el SDK emite `disconnected` con `reason: "token-expired"`. Tu web pide uno nuevo a tu backend y crea otro cliente.
- Tu backend puede revocar un token de inmediato: `DELETE /v1/tokens/{jti}`.

### Cliente RTC

```js
import { createRtc } from "@movatec/rtc-sdk";

const rtc = createRtc(token, { apiBaseUrl: "https://rtc-api.movatec.cl" });

rtc.on("connected", (e) => console.log("registrado como", e.identity, "CLIs:", e.allowedCli));
rtc.on("disconnected", (e) => console.log("desconectado:", e.reason));
rtc.on("reconnecting", () => console.log("reconectando…"));
rtc.on("error", (e) => console.error(e));

await rtc.connect();
```

### Llamar a un número telefónico

```js
const call = rtc.callPhone("+56912345678", { from: "+56221234567" });

call.on("ringing", () => console.log("timbrando"));
call.on("established", () => console.log("en llamada"));
call.on("hangup", (h) => console.log("fin:", h.reason, h.sipCode ?? ""));

call.mute(true);      call.unmute();
await call.hold();    await call.resume();
call.sendDTMF("1");
await call.hangup();
```

`from` debe ser uno de los CLIs autorizados en el token; si no, `callPhone` lanza una excepción y, en cualquier caso, el borde de Movatec rechaza la llamada con 403. Una sesión mantiene una llamada a la vez.

### Recibir una llamada

Si Movatec asigna un DID de tu cuenta a una identidad, las llamadas a ese número suenan en el navegador donde esa identidad esté conectada. El token debe incluir la capacidad `inbound`.

```js
rtc.on("incoming-webrtc-call", (ev) => {
  console.log(`llamada de ${ev.from} al DID ${ev.to}`, ev.kind); // kind: "phone" | "user"
  ev.call.on("established", () => console.log("contestada"));
  ev.call.accept();        // o ev.call.decline()
});
```

### Llamar a otro usuario de tu cuenta

```js
const call = rtc.callUser("supervisor.3");   // suena en el navegador de esa identidad
```

No pasa por la red telefónica ni se factura; solo entre identidades de la misma cuenta.

### Calidad de red

Durante la llamada el SDK mide cada 2 segundos desde el navegador y emite un puntaje explicable:

```js
call.on("network-quality", (q) => {
  // q.score 1..5, q.label, q.rttMs, q.jitterMs, q.packetLossPct, q.mos, q.bitrateKbps, q.candidateType
  if (q.changed) mostrarIndicador(q.score);
});
```

La medición se reporta a Movatec para diagnóstico conjunto (desactivable con `reportQuality: false`).

### Dispositivos de audio

```js
const mics = await rtc.getAudioInputDevices();     // [{deviceId, label, isDefault}]
const spks = await rtc.getAudioOutputDevices();
await rtc.setAudioInputDevice(mics[1].deviceId);   // también en plena llamada
await rtc.setAudioOutputDevice(spks[0].deviceId);  // si rtc.canSelectOutput()

rtc.on("device-change", (d) => refrescarSelectores(d.inputs, d.outputs));
rtc.on("input-device-lost", (d) => avisar(`se perdió ${d.label}`, d.recovered));
rtc.on("audio-level", (a) => vuMeter(a.level));    // 0..1
```

### Migrar desde infobip-rtc-js

| infobip-rtc-js | @movatec/rtc-sdk |
|---|---|
| `createInfobipRtc(token, config)` | `createRtc(token, { apiBaseUrl })` |
| `infobipRTC.connect()` / `disconnect()` | igual |
| `callPhone(number, options)` | `callPhone(number, { from })` |
| `callWebrtc(identity)` | `callUser(identity)` |
| `on("incoming-webrtc-call")` | igual (`ev.call.accept()` / `decline()`) |
| `call.mute()` / `unmute()` / `hangup()` / `sendDTMF()` | iguales |
| `call.hold()` / `resume()` | iguales |
| `getAudioInputDevices()` … | iguales |
| video, pantalla compartida, salas, Viber | no disponibles (solo audio) |

### Compatibilidad de navegadores

Chrome/Edge 100+, Firefox 100+, Safari 16+ (escritorio y móvil). La selección de parlante (`setSinkId`) no está disponible en Safari ni Firefox.

### Referencia completa

[docs/API.md](docs/API.md). Tipos TypeScript incluidos en el paquete.

### Soporte

soporte@movatec.cl · Indica siempre el `sipCallId()` de la llamada: con él Movatec ubica la traza completa en su plataforma.

### Licencia

MIT © Movatec SpA
