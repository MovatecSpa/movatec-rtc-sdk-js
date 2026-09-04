# Referencia de API — @movatec/rtc-sdk

Todos los métodos y eventos están tipados en `dist/index.d.ts`. Aquí, la superficie pública.

## `createRtc(token, options): MovatecRTC`
| Opción | Tipo | Default | Descripción |
|---|---|---|---|
| `apiBaseUrl` | string | requerido | URL de la Movatec RTC API, p. ej. `https://rtc-api.movatec.cl` |
| `audioElement` | HTMLAudioElement | se crea uno oculto | dónde reproducir el audio remoto |
| `autoReconnect` | boolean | `true` | reconectar el WebSocket con backoff |
| `registerExpires` | number | `300` | segundos entre re-REGISTER |
| `reportQuality` | boolean | `true` | enviar la calidad de red medida a la plataforma |
| `iceTransportPolicy` | `"relay"` \| `"all"` | `"relay"` | la media siempre viaja por los servidores TURN de Movatec |
| `audioInputDeviceId` / `audioOutputDeviceId` | string | predeterminado | dispositivos iniciales |
| `autoRecoverInput` | boolean | `true` | si el micrófono en uso desaparece, pasar al predeterminado |
| `audioLevel` | boolean | `true` | emitir `audio-level` |
| `debug` | boolean | `false` | logs de SIP.js en consola |

## `MovatecRTC`
| Método | Descripción |
|---|---|
| `connect()` | obtiene credenciales efímeras con el token y registra. Resuelve al quedar registrado |
| `disconnect()` | cuelga, des-registra y cierra |
| `callPhone(numero, { from, customHeaders })` | llamada a un número E.164 presentando el CLI `from` (debe estar autorizado para el usuario) |
| `callUser(identidad)` | llamada a otro usuario registrado de la misma cuenta (no pasa por la red telefónica) |
| `allowedCli()` | CLIs autorizados en el token |
| `isConnected()` | registrado o no |
| `getAudioInputDevices()` / `getAudioOutputDevices()` | dispositivos (pide permiso una vez para obtener etiquetas) |
| `setAudioInputDevice(id)` / `setAudioOutputDevice(id)` | cambio de micrófono / parlante, también durante una llamada |
| `selectedDevices()` / `canSelectOutput()` | estado de selección; `setSinkId` no existe en todos los navegadores |

Eventos (`rtc.on(evento, fn)`): `connected` `{identity, allowedCli, capabilities}` · `disconnected` `{reason: user|token-expired|transport|auth-failed|server}` · `reconnecting` · `incoming-webrtc-call` `{call, from, to, identity, kind}` · `error` · `device-change` · `input-device-lost` · `output-device-lost` · `audio-level` `{level, speaking}`.

## `PhoneCall`
| Método | Descripción |
|---|---|
| `accept()` / `decline(code=486)` | solo entrantes |
| `hangup()` | cuelga o cancela |
| `mute(bool)` / `unmute()` / `isMuted()` | micrófono |
| `hold()` / `resume()` / `isOnHold()` | retención (re-INVITE) |
| `sendDTMF("1234#")` | tonos RFC 4733 |
| `transfer(destino)` | reservado: hoy emite `transfer-failed` (501) |
| `networkQuality()` | última medición |
| `duration()` / `id()` / `sipCallId()` | duración en s, id de sesión, Call-ID SIP (el que ve el soporte de Movatec) |
| `direction` / `kind` | `outbound|inbound` · `phone|user` |

Eventos (`call.on`): `ringing` · `established` · `hangup` `{reason, sipCode, sipReason}` · `error` · `muted` / `unmuted` · `hold` / `resume` · `network-quality` `{score, label, rttMs, jitterMs, packetLossPct, mos, bitrateKbps, candidateType, changed}` · `transfer-accepted` / `transfer-failed`.

## Códigos de error frecuentes
| Situación | Qué ve el SDK |
|---|---|
| Token vencido o revocado | `disconnected {reason: "token-expired"}` |
| CLI no autorizado | excepción en `callPhone` o `hangup {sipCode: 403}` |
| Usuario destino no registrado (`callUser`) | `error {code: "USER_NOT_REGISTERED"}` |
| Segunda llamada simultánea | excepción "Ya hay una llamada activa" |
