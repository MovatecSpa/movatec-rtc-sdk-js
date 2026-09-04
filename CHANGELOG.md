# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es/1.1.0/). Versionado semántico.

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
