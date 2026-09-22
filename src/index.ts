/**
 * Movatec RTC SDK — wrapper sobre SIP.js 0.21 con superficie compatible con infobip-rtc-js.
 *
 * Uso mínimo (idéntico en forma a InfobipRTC):
 *   const rtc = createRtc(token, { apiBaseUrl: "https://rtc-api.movatec.cl" });
 *   rtc.on("connected", () => ...);
 *   rtc.on("disconnected", (e) => ...);
 *   rtc.on("incoming-webrtc-call", (ev) => ev.call.accept());   // v1: no llega nunca (inbound por troncal)
 *   await rtc.connect();
 *   const call = rtc.callPhone("+56912345678", { from: "+56221234567" });
 *   call.on("established", ...); call.mute(true); call.sendDTMF("1"); call.hangup();
 *
 * Diseño:
 *  - El token JWT NO contiene la contraseña SIP. `connect()` llama a GET /v1/rtc/session (Bearer JWT)
 *    y recibe credenciales SIP efímeras + ICE/TURN efímero. Ambas expiran con el JWT.
 *  - El CLI (`from`) se valida localmente contra `allowed_cli` del token para dar error temprano,
 *    pero la validación que manda es la del edge (Kamailio) — el SDK no es frontera de seguridad.
 *  - Sin lógica oculta: cada estado emite un evento con `reason`.
 */
import {
  Inviter, Invitation, Registerer, RegistererState, Session, SessionState,
  UserAgent, UserAgentOptions, URI, Web,
} from "sip.js";

// --------------------------------------------------------------------------- tipos públicos
export type RtcEvent = "connected" | "disconnected" | "reconnecting" | "incoming-webrtc-call" | "error"
  | "device-change" | "input-device-lost" | "output-device-lost" | "audio-level";

/** Dispositivo de audio (micrófono o parlante) tal como lo reporta el navegador. */
export interface AudioDevice { deviceId: string; label: string; kind: "audioinput" | "audiooutput"; isDefault: boolean; }
export interface DeviceChangeEvent { inputs: AudioDevice[]; outputs: AudioDevice[]; }
export interface DeviceLostEvent { deviceId: string; label: string; recovered: boolean; }
/** Nivel del micrófono local, 0..1 (RMS normalizado), cada ~500 ms durante la llamada. */
export interface AudioLevelEvent { level: number; speaking: boolean; }
export type CallEvent = "calling" | "progress" | "ringing" | "established" | "hangup" | "error" | "muted" | "unmuted" | "network-quality" | "hold" | "resume" | "transfer-accepted" | "transfer-failed" | "outbound-ani";

/**
 * Número que la plataforma presentó realmente al destino.
 *
 * El CLI que envía el navegador es sólo la entrada: la red puede reescribir el ANI (por ejemplo
 * con un pool rotativo), así que el número que ve quien recibe la llamada no se conoce hasta
 * que se cursa. Se resuelve solo, unos segundos después de colgar, y llega en el evento
 * `outbound-ani`. Guárdalo junto a la gestión para reconocer la devolución del llamado.
 */
export interface OutboundAniEvent {
  /** Número presentado al destino. */
  ani: string;
  /** CLI que se envió desde el navegador (puede diferir del presentado). */
  cliEnviado: string | null;
  destino: string | null;
  sipCode: number | null;
  /** Call-ID SIP, el mismo de `call.sipCallId()`. */
  callId: string;
}

/**
 * Causa legible del fin de una llamada. Permite mostrarle algo util al operador sin
 * que la aplicacion tenga que interpretar codigos SIP.
 */
export type HangupCause =
  | "numero-invalido"        // 400/404/484: el numero no existe o esta mal formado
  | "destino-no-habilitado"  // 403 desde la red: el destino/pais no esta habilitado en la cuenta
  | "cli-no-permitido"       // 403 del edge: el CLI presentado no esta en la whitelist del token
  | "sin-saldo"              // 402/403 con indicio de saldo/credito
  | "ocupado"                // 486/600
  | "no-contesta"            // 408 extremo a extremo / 480 tras timbrar
  | "no-disponible"          // 480/503: destino apagado, fuera de cobertura o sin ruta
  | "rechazada"              // 603 y rechazos explicitos
  | "usuario-no-registrado"  // 480 en llamadas internas entre usuarios
  | "sin-respuesta-red"      // 408 sin haber timbrado: la red no respondio
  | "cancelada"              // 487: se colgo antes de que contestaran
  | "colgada"                // fin normal
  | "error-interno";         // 5xx nuestro o excepcion local

/** Respuesta provisional recibida (100/180/183). `earlyMedia` = el 183 trae audio de la red. */
export interface ProgressEvent { sipCode: number; sipReason?: string; earlyMedia: boolean; }

/** Calidad de red medida en el navegador con RTCPeerConnection.getStats() (cada 2 s). score: 5 excelente … 1 inutilizable. */
export interface NetworkQuality {
  score: 1 | 2 | 3 | 4 | 5;
  label: "excelente" | "buena" | "regular" | "mala" | "inutilizable";
  rttMs: number | null;          // ida y vuelta al edge/TURN (candidate-pair)
  jitterMs: number | null;       // jitter de recepción
  packetLossPct: number | null;  // pérdida acumulada de recepción
  mos: number | null;            // MOS estimado (E-model simplificado)
  bitrateKbps: number | null;    // recepción
  candidateType: string | null;  // host | srflx | relay (relay = vía coturn)
}

export type CallKind = "phone" | "user";

export interface IncomingCallEvent {
  call: PhoneCall;
  /** DID marcado por el llamante (usuario del To), o tu identidad si es una llamada interna. */
  to: string;
  /** Número del llamante (From), o la identidad del agente que llama si es interna. */
  from: string;
  /** Identidad destino resuelta por la plataforma (X-Movatec-Identity), si viene. */
  identity?: string;
  /** "phone": llegó por un DID desde la red; "user": otro usuario del mismo cliente (no pasa por Yeti, no se factura). */
  kind: CallKind;
}

export interface RtcOptions {
  /** Base URL de la Token API (p. ej. https://rtc-api.movatec.cl). */
  apiBaseUrl: string;
  /** Elemento <audio> donde reproducir el remoto. Si se omite, el SDK crea uno oculto. */
  audioElement?: HTMLAudioElement;
  /** Reintentar el WebSocket automáticamente (default true). */
  autoReconnect?: boolean;
  /** Intervalo de re-REGISTER en segundos (default 300, igual al default del edge). */
  registerExpires?: number;
  /** Log a consola (default false). */
  debug?: boolean;
  /** Enviar la calidad de red medida a la plataforma (visible en el panel de operación). Default true. */
  reportQuality?: boolean;
  /** Política ICE. Default "relay": la media siempre va por coturn (única ruta abierta hacia el edge). */
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** Micrófono inicial (deviceId de getAudioInputDevices). Se puede cambiar luego con setAudioInputDevice. */
  audioInputDeviceId?: string;
  /** Parlante inicial (deviceId de getAudioOutputDevices). Requiere setSinkId (Chrome/Edge). */
  audioOutputDeviceId?: string;
  /** Si el micrófono en uso desaparece en plena llamada, pasar automáticamente al predeterminado. Default true. */
  autoRecoverInput?: boolean;
  /** Emitir "audio-level" con el nivel del micrófono local durante la llamada. Default true. */
  audioLevel?: boolean;
  /**
   * Reproducir un tono de llamada local mientras el destino timbra (default true).
   * Si la red manda early media (183 con audio), se usa ese audio y el tono local no suena.
   */
  ringbackTone?: boolean;
  /**
   * Resolver automáticamente el número presentado al destino al terminar cada llamada saliente
   * (evento `outbound-ani`). Default true. Implica una consulta HTTP a la plataforma por llamada.
   */
  resolveOutboundAni?: boolean;
}

export interface CallPhoneOptions {
  /** CLI E.164 a presentar. Debe estar en allowed_cli del token. Default: default_cli de la sesión. */
  from?: string;
  /** Headers SIP X-* adicionales (uso interno/diagnóstico; el edge los elimina antes de Yeti). */
  customHeaders?: Record<string, string>;
  /** SOLO para validación: omite la comprobación local del CLI para que sea el edge quien lo rechace (403). */
  __skipLocalCliCheck?: boolean;
}

export interface DisconnectedEvent { reason: "user" | "token-expired" | "transport" | "auth-failed" | "server"; detail?: string; }
export interface HangupEvent {
  reason: "local" | "remote" | "rejected" | "timeout" | "error";
  sipCode?: number;
  sipReason?: string;
  /** Causa interpretada, lista para decidir que mostrar al operador. */
  cause?: HangupCause;
  /** Texto en espanol correspondiente a `cause`, para pintar directo en pantalla. */
  causeText?: string;
  /** true si la llamada alcanzo a timbrar en el destino (hubo 180/183). */
  rang?: boolean;
}

/** Texto por defecto de cada causa (es-CL). */
export const HANGUP_CAUSE_TEXT: Record<HangupCause, string> = {
  "numero-invalido": "El numero marcado no es valido o no existe",
  "destino-no-habilitado": "El destino no esta habilitado para esta cuenta",
  "cli-no-permitido": "El numero de presentacion no esta autorizado",
  "sin-saldo": "Sin saldo o credito suficiente para cursar la llamada",
  "ocupado": "El destino esta ocupado",
  "no-contesta": "El destino no contesto",
  "no-disponible": "El destino no esta disponible en este momento",
  "rechazada": "La llamada fue rechazada",
  "usuario-no-registrado": "El usuario no esta conectado",
  "sin-respuesta-red": "La red no respondio la llamada",
  "cancelada": "Llamada cancelada antes de contestar",
  "colgada": "Llamada finalizada",
  "error-interno": "Error interno al cursar la llamada",
};

/**
 * Traduce un codigo SIP a una causa de negocio.
 * `rang` distingue 408/480 "nunca timbro" (problema de red/ruta) de "timbro y no contestaron".
 */
export function sipCause(code: number, reason?: string, rang = false): HangupCause {
  const r = (reason ?? "").toLowerCase();
  if (/balance|credit|saldo|payment|funds/.test(r)) return "sin-saldo";
  // Yeti responde "404 No routes" cuando el prefijo/pais no esta habilitado en la cuenta:
  // eso NO es un numero mal marcado, es un destino no habilitado. Distinguirlos importa
  // porque la accion del operador es distinta (corregir el numero vs. pedir habilitacion).
  if (/no route|not allowed|forbidden dst|destination/.test(r)) return "destino-no-habilitado";
  switch (code) {
    case 400: case 404: case 484: case 485: return "numero-invalido";
    case 402: return "sin-saldo";
    case 403: return /cli|caller|from/.test(r) ? "cli-no-permitido" : "destino-no-habilitado";
    case 408: return rang ? "no-contesta" : "sin-respuesta-red";
    case 410: return "numero-invalido";
    case 480: return rang ? "no-contesta" : "no-disponible";
    case 486: case 600: return "ocupado";
    case 487: return "cancelada";
    case 503: return "no-disponible";
    case 603: return "rechazada";
    default:
      if (code >= 500 && code < 600) return "error-interno";
      if (code >= 400) return "rechazada";
      return "colgada";
  }
}

interface RtcSession {
  sip: { realm: string; username: string; password: string; wss_uri: string; expires_at: number };
  ice_servers: RTCIceServer[];
  allowed_cli: string[];
  default_cli: string | null;
  capabilities: string[];
}

// --------------------------------------------------------------------------- emisor mínimo
class Emitter<E extends string> {
  private handlers = new Map<E, Set<(payload: any) => void>>();
  on(event: E, fn: (payload: any) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: E, fn: (payload: any) => void): this { this.handlers.get(event)?.delete(fn); return this; }
  /** Público por necesidad (PhoneCall lo usa desde MovatecRTC); no forma parte de la API documentada. */
  emit(event: E, payload?: any): void {
    this.handlers.get(event)?.forEach((fn) => { try { fn(payload); } catch (e) { console.error("[movatec-rtc] handler error", e); } });
  }
}

// --------------------------------------------------------------------------- llamada
/**
 * Tono de llamada generado localmente con WebAudio (no consume red ni depende de que
 * la operadora mande early media). Cadencia chilena por defecto: 400 Hz, 1 s on / 3 s off.
 * Si el navegador bloquea el AudioContext por autoplay, falla en silencio: nunca rompe la llamada.
 */
class Ringback {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private osc: OscillatorNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private playing = false;

  constructor(private freqHz = 400, private onMs = 1000, private offMs = 3000, private volume = 0.12) {}

  start(sinkId?: string | null) {
    if (this.playing) return;
    try {
      const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      void this.ctx!.resume().catch(() => {});
      this.gain = this.ctx!.createGain();
      this.gain.gain.value = 0;
      this.osc = this.ctx!.createOscillator();
      this.osc.type = "sine";
      this.osc.frequency.value = this.freqHz;
      this.osc.connect(this.gain);
      this.gain.connect(this.ctx!.destination);
      this.osc.start();
      this.playing = true;
      const beep = () => {
        if (!this.ctx || !this.gain) return;
        const t = this.ctx.currentTime;
        // rampas cortas para evitar el "click" de abrir/cerrar la ganancia de golpe
        this.gain.gain.setValueAtTime(0, t);
        this.gain.gain.linearRampToValueAtTime(this.volume, t + 0.02);
        this.gain.gain.setValueAtTime(this.volume, t + this.onMs / 1000 - 0.02);
        this.gain.gain.linearRampToValueAtTime(0, t + this.onMs / 1000);
      };
      beep();
      this.timer = setInterval(beep, this.onMs + this.offMs);
    } catch {
      this.stop();
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.osc?.stop(); } catch {}
    try { this.gain?.disconnect(); } catch {}
    try { void this.ctx?.close(); } catch {}
    this.osc = null; this.gain = null; this.ctx = null; this.playing = false;
  }
}

export class PhoneCall extends Emitter<CallEvent> {
  private muted = false;
  private startedAt: number | null = null;
  private qualityTimer: number | null = null;
  private lastQuality: NetworkQuality | null = null;
  private prevStats: { ts: number; bytes: number; lost: number; received: number } | null = null;
  readonly direction: "outbound" | "inbound";
  /** "phone" = por Yeti hacia/desde la red; "user" = interna entre usuarios del mismo cliente. */
  readonly kind: CallKind;
  constructor(private session: Session, private audio: HTMLAudioElement, readonly destination: string, readonly from: string,
              private onQuality?: (q: NetworkQuality, callId: string) => void, kind: CallKind = "phone") {
    super();
    this.kind = kind;
    this.direction = session instanceof Invitation ? "inbound" : "outbound";
    session.stateChange.addListener((state) => {
      switch (state) {
        // OJO: SIP.js entra en Establishing al ENVIAR el INVITE, no cuando el destino timbra.
        // Emitir "ringing" aquí era un falso positivo: la llamada "sonaba" aunque la red la
        // hubiera descartado. Ahora esto es "calling" y el "ringing" real sale del 180/183.
        case SessionState.Establishing: this.emit("calling"); break;
        case SessionState.Established:
          this.ringback.stop();
          this.startedAt = Date.now(); this.attachRemoteAudio(); this.startQuality(); this.emit("established"); break;
        // Terminated llega antes que requestDelegate.onReject: se difiere para que el evento traiga el código SIP (p. ej. 403 del edge)
        case SessionState.Terminated:
          this.ringback.stop();
          this.stopQuality();
          setTimeout(() => this.emit("hangup", this.buildHangup()), 0);
          void this.resolveOutboundAni();
          break;
      }
    });
  }
  private lastHangup: HangupEvent | null = null;
  /** Número presentado al destino; null hasta que la plataforma lo resuelve (ver evento "outbound-ani"). */
  outboundAni: string | null = null;
  /** Lo inyecta MovatecRTC: consulta la plataforma por el ANI de este Call-ID. */
  _aniLookup?: (callId: string) => Promise<OutboundAniEvent | null>;
  private ringback = new Ringback();
  private rang = false;
  private earlyMedia = false;
  /** Reproducir tono de llamada local mientras timbra. Lo fija MovatecRTC desde RtcOptions. */
  ringbackEnabled = true;

  /** true si el destino alcanzó a timbrar (llegó 180 o 183). */
  get hasRung(): boolean { return this.rang; }

  /**
   * Uso interno: respuesta provisional de la red (100/180/183).
   * 183 con SDP = audio real de la operadora (locución, tono propio): se engancha ese audio
   * y NO se genera tono local, para no pisar el mensaje que la red está mandando.
   */
  _onProgress(code: number, reason: string | undefined, hasSdp: boolean) {
    if (code === 100) return;                      // Trying: la red tomó el INVITE, aún no timbra
    const early = code === 183 && hasSdp;
    this.emit("progress", { sipCode: code, sipReason: reason, earlyMedia: early } as ProgressEvent);
    if (code !== 180 && code !== 183) return;
    if (early && !this.earlyMedia) { this.earlyMedia = true; this.ringback.stop(); this.attachRemoteAudio(); }
    if (this.rang) return;
    this.rang = true;
    if (!this.earlyMedia && this.ringbackEnabled) this.ringback.start();
    this.emit("ringing", { sipCode: code, sipReason: reason, earlyMedia: early } as ProgressEvent);
  }

  /**
   * Resuelve el número presentado al destino. Se llama solo al terminar la llamada; también
   * puede invocarse a mano. El dato viene del CDR de la red, que tarda unos segundos en estar
   * disponible (medido: < 10 s), así que se reintenta con espera creciente hasta ~25 s.
   * Devuelve null si no se pudo resolver (sin red, llamada que nunca salió, etc.).
   */
  async resolveOutboundAni(): Promise<OutboundAniEvent | null> {
    if (this.outboundAni) return null;                 // ya resuelto: no se re-emite
    if (!this._aniLookup || this.direction !== "outbound" || this.kind !== "phone") return null;
    const callId = this.sipCallId();
    for (const waitMs of [1500, 2500, 4000, 6000, 10000]) {
      await new Promise((r) => setTimeout(r, waitMs));
      let info: OutboundAniEvent | null = null;
      try { info = await this._aniLookup(callId); } catch { /* reintento */ }
      if (info?.ani) {
        this.outboundAni = info.ani;
        this.emit("outbound-ani", info);
        return info;
      }
    }
    return null;
  }

  /** Completa el evento de corte con causa legible. */
  private buildHangup(): HangupEvent {
    const h = this.lastHangup ?? { reason: "remote" as const };
    if (h.cause) return { ...h, rang: this.rang };
    const code = h.sipCode ?? 0;
    const cause: HangupCause = h.reason === "local" ? "colgada"
      : code ? sipCause(code, h.sipReason, this.rang)
      : (h.reason === "error" ? "error-interno" : "colgada");
    return { ...h, cause, causeText: HANGUP_CAUSE_TEXT[cause], rang: this.rang };
  }

  /** Restricciones de media para esta llamada (micrófono elegido). Las fija MovatecRTC; default: cualquier micrófono. */
  mediaConstraints: MediaStreamConstraints = { audio: true, video: false };

  /** Llamada entrante: contestar (pide micrófono). */
  async accept(): Promise<void> {
    if (!(this.session instanceof Invitation)) throw new Error("accept() solo aplica a llamadas entrantes");
    await this.session.accept({ sessionDescriptionHandlerOptions: { constraints: this.mediaConstraints } });
  }
  /** Pista de audio local que se está enviando (null si aún no hay media). */
  localAudioTrack(): MediaStreamTrack | null {
    const pc = (this.session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined)?.peerConnection;
    return pc?.getSenders().find((sn) => sn.track?.kind === "audio")?.track ?? null;
  }
  /** Cambia el micrófono en caliente: reemplaza la pista enviada (RTCRtpSender.replaceTrack) sin renegociar SIP. */
  async replaceAudioTrack(track: MediaStreamTrack): Promise<boolean> {
    const pc = (this.session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined)?.peerConnection;
    const sender = pc?.getSenders().find((sn) => sn.track?.kind === "audio");
    if (!sender) return false;
    const old = sender.track;
    await sender.replaceTrack(track);
    track.enabled = !this.muted;   // respeta el estado de mute
    old?.stop();
    return true;
  }
  /** Llamada entrante: rechazar (486 Busy por defecto). */
  async decline(statusCode = 486): Promise<void> {
    if (!(this.session instanceof Invitation)) throw new Error("decline() solo aplica a llamadas entrantes");
    this.lastHangup = { reason: "local" };
    await this.session.reject({ statusCode });
  }
  /** Última medición de calidad de red (null hasta que la llamada esté establecida). */
  networkQuality(): NetworkQuality | null { return this.lastQuality; }

  private startQuality() {
    this.qualityTimer = window.setInterval(() => this.measure().catch(() => {}), 2000);
  }
  private stopQuality() { if (this.qualityTimer) { clearInterval(this.qualityTimer); this.qualityTimer = null; } }

  /** Lee getStats() y calcula un puntaje explicable: RTT, jitter y pérdida → MOS (E-model simplificado) → score 1..5. */
  private async measure(): Promise<void> {
    const pc = (this.session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined)?.peerConnection;
    if (!pc) return;
    const stats = await pc.getStats();
    let rtt: number | null = null, jitter: number | null = null, lost = 0, received = 0, bytes = 0, candidateType: string | null = null;
    // Par ICE en uso: primero el que indica "transport" (selectedCandidatePairId); si no, el par nominado/exitoso
    let pairId: string | null = null;
    stats.forEach((r: any) => { if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
    stats.forEach((r: any) => {
      if (r.type === "candidate-pair" && ((pairId && r.id === pairId) || (!pairId && (r.nominated || r.selected) && r.state === "succeeded"))) {
        if (r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000;
        else if (r.totalRoundTripTime != null && r.responsesReceived) rtt = (r.totalRoundTripTime / r.responsesReceived) * 1000;
        const local = (stats as any).get(r.localCandidateId); if (local?.candidateType) candidateType = local.candidateType;
      }
      if (r.type === "inbound-rtp" && r.kind === "audio") {
        if (r.jitter != null) jitter = r.jitter * 1000;
        lost = r.packetsLost ?? 0; received = r.packetsReceived ?? 0; bytes = r.bytesReceived ?? 0;
      }
    });
    const now = Date.now();
    let bitrate: number | null = null, lossPct: number | null = null;
    if (this.prevStats) {
      const dt = (now - this.prevStats.ts) / 1000;
      bitrate = dt > 0 ? Math.round(((bytes - this.prevStats.bytes) * 8) / dt / 1000) : null;
      const dRecv = received - this.prevStats.received, dLost = lost - this.prevStats.lost;
      lossPct = dRecv + dLost > 0 ? Math.round((100 * dLost) / (dRecv + dLost) * 10) / 10 : 0;
    }
    this.prevStats = { ts: now, bytes, lost, received };
    // E-model simplificado (ITU-T G.107): R = 93.2 - Id(rtt) - Ie(loss); MOS desde R.
    let mos: number | null = null;
    if (rtt != null || lossPct != null) {
      const d = (rtt ?? 0) / 2 + (jitter ?? 0) * 2 + 20;               // retardo efectivo aproximado (ms)
      const Id = d < 160 ? d / 40 : (d - 120) / 10;
      const Ie = 30 * Math.log(1 + 15 * ((lossPct ?? 0) / 100));       // impairment por pérdida (opus/G.711 aprox.)
      const R = Math.max(0, Math.min(100, 93.2 - Id - Ie));
      mos = R < 0 ? 1 : R > 100 ? 4.5 : 1 + 0.035 * R + 7e-6 * R * (R - 60) * (100 - R);
      mos = Math.round(mos * 100) / 100;
    }
    const score: NetworkQuality["score"] = mos == null ? 3 : mos >= 4.0 ? 5 : mos >= 3.6 ? 4 : mos >= 3.1 ? 3 : mos >= 2.6 ? 2 : 1;
    const label = (["inutilizable", "mala", "regular", "buena", "excelente"] as const)[score - 1];
    const q: NetworkQuality = { score, label, rttMs: rtt != null ? Math.round(rtt) : null, jitterMs: jitter != null ? Math.round(jitter) : null,
      packetLossPct: lossPct, mos, bitrateKbps: bitrate, candidateType };
    const changed = !this.lastQuality || this.lastQuality.score !== q.score;
    this.lastQuality = q;
    this.emit("network-quality", { ...q, changed });
    // Se reporta con el Call-ID SIP real (no el id interno de SIP.js) para que el panel lo correlacione con la llamada
    this.onQuality?.(q, this.sipCallId());
  }
  /** Cuelga (o cancela si aún no contestan). */
  async hangup(): Promise<void> {
    this.lastHangup = { reason: "local" };
    const s = this.session;
    if (s.state === SessionState.Initial || s.state === SessionState.Establishing) {
      if (s instanceof Inviter) await s.cancel(); else if (s instanceof Invitation) await s.reject();
    } else if (s.state === SessionState.Established) {
      await s.bye();
    }
  }
  mute(shouldMute = true): void {
    const pc = (this.session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined)?.peerConnection;
    pc?.getSenders().forEach((snd) => { if (snd.track?.kind === "audio") snd.track.enabled = !shouldMute; });
    this.muted = shouldMute;
    this.emit(shouldMute ? "muted" : "unmuted");
  }
  unmute(): void { this.mute(false); }
  isMuted(): boolean { return this.muted; }

  private onHold = false;
  /** Pone la llamada en espera: re-INVITE con a=sendonly (SIP.js holdModifier), deja de enviar micrófono y silencia el remoto. */
  async hold(): Promise<void> {
    if (this.session.state !== SessionState.Established) throw new Error("hold() solo con la llamada establecida");
    if (this.onHold) return;
    await this.session.invite({ sessionDescriptionHandlerModifiers: [Web.holdModifier] });
    this.setLocalTracks(false); this.audio.muted = true; this.onHold = true;
    this.emit("hold");
  }
  /** Reanuda: re-INVITE con a=sendrecv y vuelve a enviar/recibir audio. */
  async resume(): Promise<void> {
    if (!this.onHold) return;
    await this.session.invite({ sessionDescriptionHandlerModifiers: [] });
    this.setLocalTracks(!this.muted); this.audio.muted = false; this.onHold = false;
    this.emit("resume");
  }
  isOnHold(): boolean { return this.onHold; }
  private setLocalTracks(enabled: boolean) {
    const pc = (this.session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined)?.peerConnection;
    pc?.getSenders().forEach((snd) => { if (snd.track?.kind === "audio") snd.track.enabled = enabled; });
  }

  /**
   * Transferencia ciega (REFER). `target`: E.164 (+569…) o identidad de otro usuario del mismo cliente.
   * LIMITACIÓN ACTUAL: Yeti no acepta REFER en el diálogo (su Allow no lo incluye) y el edge no es B2BUA, así que la
   * plataforma responde 501 y se emite `transfer-failed` con ese código. La transferencia real requiere el B2BUA (ver README).
   */
  async transfer(target: string): Promise<void> {
    if (this.session.state !== SessionState.Established) throw new Error("transfer() solo con la llamada establecida");
    const realm = this.session.userAgent.configuration.uri?.host ?? "rtc.movatec.cl";
    const own = this.session.userAgent.configuration.uri?.user ?? "";           // t<tenant>.<identidad>.<hex>
    const tenant = own.startsWith("t") ? own.slice(1).split(".")[0] : "";
    const dst = target.replace(/[\s().-]/g, "");
    const uriStr = /^\+[1-9]\d{6,14}$/.test(dst) ? `sip:${dst}@${realm}` : /^[A-Za-z0-9._@-]+$/.test(target) ? `sip:${tenant}.${target}@${realm}` : "";
    if (!uriStr) throw new Error(`destino de transferencia inválido: ${target}`);
    const uri = UserAgent.makeURI(uriStr)!;
    await this.session.refer(uri, {
      requestDelegate: {
        onAccept: (r) => this.emit("transfer-accepted", { target: uriStr, sipCode: r.message.statusCode }),
        onReject: (r) => this.emit("transfer-failed", { target: uriStr, sipCode: r.message.statusCode, sipReason: r.message.reasonPhrase }),
      },
    });
  }
  /** DTMF RFC 4733 (out-of-band). `tones` acepta 0-9 * # A-D. */
  sendDTMF(tones: string): boolean {
    if (!/^[0-9A-D*#]+$/i.test(tones)) throw new Error("DTMF inválido");
    const sdh = this.session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    return sdh?.sendDtmf(tones) ?? false;
  }
  duration(): number { return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0; }
  id(): string { return this.session.id; }
  /** Call-ID SIP de la llamada (el mismo que ve el panel de operación y Yeti). */
  sipCallId(): string { return ((this.session as any).request?.callId as string | undefined) ?? this.session.id; }
  /** Uso interno: fija la razón de corte cuando viene de rechazo/timeout. */
  _setHangup(h: HangupEvent) { this.lastHangup = h; }
  private attachRemoteAudio() {
    const sdh = this.session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    const pc = sdh?.peerConnection; if (!pc) return;
    const stream = new MediaStream();
    pc.getReceivers().forEach((r) => { if (r.track) stream.addTrack(r.track); });
    this.audio.srcObject = stream;
    this.audio.play().catch((e) => console.warn("[movatec-rtc] autoplay bloqueado", e));
  }
}

// --------------------------------------------------------------------------- cliente
export class MovatecRTC extends Emitter<RtcEvent> {
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private session: RtcSession | null = null;
  private audio: HTMLAudioElement;
  private expiryTimer: number | null = null;
  private activeCall: PhoneCall | null = null;
  private stopping = false;

  constructor(private token: string, private opts: RtcOptions) {
    super();
    this.audio = opts.audioElement ?? Object.assign(document.createElement("audio"), { autoplay: true, hidden: true });
    if (!opts.audioElement) document.body.appendChild(this.audio);
    this.inputDeviceId = opts.audioInputDeviceId ?? null;
    if (opts.audioOutputDeviceId) this.setAudioOutputDevice(opts.audioOutputDeviceId).catch(() => {});
    this.installDeviceChangeListener();
  }

  /** Obtiene credenciales efímeras, conecta el WSS y hace REGISTER. Resuelve al quedar registrado. */
  async connect(): Promise<void> {
    this.stopping = false;
    this.session = await this.fetchSession();
    const s = this.session;
    const uri = UserAgent.makeURI(`sip:${s.sip.username}@${s.sip.realm}`);
    if (!uri) throw new Error("URI SIP inválida");

    const uaOptions: UserAgentOptions = {
      uri,
      authorizationUsername: s.sip.username,
      authorizationPassword: s.sip.password,
      transportOptions: { server: s.sip.wss_uri, keepAliveInterval: 25 },
      // Lección de TRUN (Engram #1361): los ICE servers van en sessionDescriptionHandlerFactoryOptions,
      // no en el UA. En 0.21 la ruta es peerConnectionConfiguration.iceServers.
      sessionDescriptionHandlerFactoryOptions: {
        // relay: por diseño TODA la media de navegadores pasa por coturn (el RTP público del edge solo acepta coturn y SEMS).
        // balanced: las ofertas entrantes (RTP plano vía rtpengine) no traen grupo BUNDLE.
        peerConnectionConfiguration: { iceServers: s.ice_servers, iceTransportPolicy: this.opts.iceTransportPolicy ?? "relay", bundlePolicy: "balanced" },
        iceGatheringTimeout: 3000,
      },
      logLevel: this.opts.debug ? "debug" : "error",
      hackIpInContact: true,
      delegate: { onInvite: (inv) => this.onIncoming(inv) },
    };
    this.ua = new UserAgent(uaOptions);
    this.ua.transport.onDisconnect = (err) => this.onTransportDown(err);
    await this.ua.start();
    this.registerer = new Registerer(this.ua, { expires: this.opts.registerExpires ?? 300 });
    await new Promise<void>((resolve, reject) => {
      const reg = this.registerer!;
      const listener = (st: RegistererState) => {
        if (st === RegistererState.Registered) { reg.stateChange.removeListener(listener); resolve(); }
        if (st === RegistererState.Terminated) { reg.stateChange.removeListener(listener); reject(new Error("REGISTER terminado")); }
      };
      reg.stateChange.addListener(listener);
      reg.register({
        requestDelegate: {
          onReject: (resp) => {
            reg.stateChange.removeListener(listener);
            const code = resp.message.statusCode;
            this.emit("disconnected", { reason: code === 401 || code === 403 ? "auth-failed" : "server", detail: `${code} ${resp.message.reasonPhrase}` } as DisconnectedEvent);
            reject(new Error(`REGISTER rechazado: ${code}`));
          },
        },
      }).catch(reject);
    });
    this.scheduleExpiry(s.sip.expires_at);
    this.emit("connected", { identity: s.sip.username, allowedCli: s.allowed_cli, capabilities: s.capabilities });
  }

  /** Cierra sesión: cuelga llamada activa, un-REGISTER y cierra el WSS. */
  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    try { await this.activeCall?.hangup(); } catch { /* ya cortada */ }
    try { await this.registerer?.unregister(); } catch { /* transporte caído */ }
    try { await this.ua?.stop(); } catch { /* idem */ }
    this.ua = null; this.registerer = null;
    this.emit("disconnected", { reason: "user" } as DisconnectedEvent);
  }

  /** Origina una llamada a un número E.164 presentando el CLI `from`. */
  callPhone(destination: string, options: CallPhoneOptions = {}): PhoneCall {
    if (!this.ua || !this.session) throw new Error("No conectado: llama a connect() primero");
    if (this.activeCall) throw new Error("Ya hay una llamada activa (v1: una llamada por sesión)");
    const dst = destination.replace(/[\s().-]/g, "");
    if (!/^\+[1-9]\d{6,14}$/.test(dst)) throw new Error(`Destino no E.164: ${destination}`);
    const from = options.from ?? this.session.default_cli ?? undefined;
    if (!from) throw new Error("No hay CLI disponible para este usuario");
    if (!options.__skipLocalCliCheck && !this.session.allowed_cli.includes(from)) throw new Error(`CLI ${from} no permitido para este usuario`);

    const target = UserAgent.makeURI(`sip:${dst}@${this.session.sip.realm}`)!;
    const fromUri = new URI("sip", from, this.session.sip.realm);
    const extraHeaders = Object.entries(options.customHeaders ?? {}).map(([k, v]) => `X-${k.replace(/^X-/i, "")}: ${v}`);
    const inviter = new Inviter(this.ua, target, {
      // From = CLI: el edge valida From contra la whitelist; el username SIP (auth) va en Authorization.
      params: { fromUri, fromDisplayName: from },
      extraHeaders,
      sessionDescriptionHandlerOptions: { constraints: this.mediaConstraints() },
    });
    const call = new PhoneCall(inviter, this.audio, dst, from, (q, id) => this.reportQuality(q, id));
    call.mediaConstraints = this.mediaConstraints();
    call.ringbackEnabled = this.opts.ringbackTone !== false;
    if (this.opts.resolveOutboundAni !== false) call._aniLookup = (id) => this.fetchOutboundAni(id);
    this.watchCallDevices(call);
    this.activeCall = call;
    call.on("hangup", () => { this.activeCall = null; });
    inviter.invite({
      requestDelegate: {
        // 100/180/183: de aquí sale el "ringing" real y el tono de llamada.
        onProgress: (resp) => call._onProgress(resp.message.statusCode ?? 0, resp.message.reasonPhrase, !!resp.message.body),
        onReject: (resp) => {
          const code = resp.message.statusCode ?? 0;
          const reason = resp.message.reasonPhrase;
          const cause = sipCause(code, reason, call.hasRung);
          call._setHangup({ reason: code === 408 ? "timeout" : "rejected", sipCode: code, sipReason: reason, cause, causeText: HANGUP_CAUSE_TEXT[cause] });
          if (code === 403) this.emit("error", { code: "CLI_NOT_ALLOWED_OR_FRAUD_CONTROL", detail: reason });
        },
      },
    }).catch((e) => { call._setHangup({ reason: "error", sipReason: String(e), cause: "error-interno", causeText: HANGUP_CAUSE_TEXT["error-interno"] }); call.emit("error", e); });
    return call;
  }

  // ------------------------------------------------------------------ dispositivos de audio
  private inputDeviceId: string | null = null;
  private outputDeviceId: string | null = null;
  private lastDevices: DeviceChangeEvent = { inputs: [], outputs: [] };
  private levelTimer: number | null = null;
  private levelCtx: AudioContext | null = null;

  /** Micrófonos disponibles. Pide permiso una vez si las etiquetas vienen vacías (el navegador las oculta sin permiso). */
  async getAudioInputDevices(): Promise<AudioDevice[]> { return (await this.enumerate()).inputs; }
  /** Parlantes disponibles. En navegadores sin setSinkId (Safari/Firefox) la lista puede venir vacía. */
  async getAudioOutputDevices(): Promise<AudioDevice[]> { return (await this.enumerate()).outputs; }
  /** Dispositivos seleccionados (null = predeterminado del sistema). */
  selectedDevices(): { input: string | null; output: string | null } { return { input: this.inputDeviceId, output: this.outputDeviceId }; }
  /** ¿El navegador permite elegir parlante? (HTMLMediaElement.setSinkId) */
  canSelectOutput(): boolean { return typeof (this.audio as any).setSinkId === "function"; }

  /** Elige el micrófono. Queda para las próximas llamadas y, si hay una activa, se cambia en caliente. */
  async setAudioInputDevice(deviceId: string | null): Promise<void> {
    this.inputDeviceId = deviceId || null;
    if (!this.activeCall) return;
    const stream = await navigator.mediaDevices.getUserMedia(this.mediaConstraints());
    const track = stream.getAudioTracks()[0];
    const ok = await this.activeCall.replaceAudioTrack(track);
    if (!ok) { track.stop(); return; }
    this.watchTrack(track);
    this.startLevelMeter(track);
  }
  /** Elige el parlante para el audio remoto (setSinkId). Lanza si el navegador no lo soporta. */
  async setAudioOutputDevice(deviceId: string | null): Promise<void> {
    if (!this.canSelectOutput()) throw new Error("Este navegador no permite elegir parlante (setSinkId)");
    await (this.audio as any).setSinkId(deviceId || "");
    this.outputDeviceId = deviceId || null;
  }

  private mediaConstraints(): MediaStreamConstraints {
    return { audio: this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : true, video: false };
  }

  private async enumerate(): Promise<DeviceChangeEvent> {
    let list = await navigator.mediaDevices.enumerateDevices();
    if (list.some((d) => d.kind === "audioinput" && !d.label)) {
      // Sin permiso el navegador no entrega etiquetas: se pide una vez y se libera el micrófono
      try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); list = await navigator.mediaDevices.enumerateDevices(); } catch { /* sin permiso: se devuelve la lista sin etiquetas */ }
    }
    const map = (d: MediaDeviceInfo): AudioDevice => ({ deviceId: d.deviceId, label: d.label || (d.kind === "audioinput" ? "Micrófono" : "Parlante"), kind: d.kind as AudioDevice["kind"], isDefault: d.deviceId === "default" });
    this.lastDevices = { inputs: list.filter((d) => d.kind === "audioinput").map(map), outputs: list.filter((d) => d.kind === "audiooutput").map(map) };
    return this.lastDevices;
  }

  private installDeviceChangeListener() {
    if (!navigator.mediaDevices?.addEventListener) return;
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      const devs = await this.enumerate();
      this.emit("device-change", devs);
      // ¿desapareció el micrófono elegido?
      if (this.inputDeviceId && !devs.inputs.some((d) => d.deviceId === this.inputDeviceId)) {
        const lost = this.inputDeviceId; this.inputDeviceId = null;
        const recovered = await this.recoverInput();
        this.emit("input-device-lost", { deviceId: lost, label: "", recovered } as DeviceLostEvent);
      }
      // ¿desapareció el parlante elegido? → volver al predeterminado
      if (this.outputDeviceId && !devs.outputs.some((d) => d.deviceId === this.outputDeviceId)) {
        const lost = this.outputDeviceId; this.outputDeviceId = null;
        let recovered = false;
        try { await (this.audio as any).setSinkId(""); recovered = true; } catch { /* sin soporte */ }
        this.emit("output-device-lost", { deviceId: lost, label: "", recovered } as DeviceLostEvent);
      }
    });
  }

  /** Con llamada activa y micrófono perdido: intenta el predeterminado (autoRecoverInput, default true). */
  private async recoverInput(): Promise<boolean> {
    if (this.opts.autoRecoverInput === false || !this.activeCall) return false;
    try { await this.setAudioInputDevice(null); return true; } catch { return false; }
  }

  /** Vigila la pista local de la llamada: si termina (micrófono desconectado) avisa e intenta recuperar. */
  private watchCallDevices(call: PhoneCall) {
    call.on("established", () => {
      const track = call.localAudioTrack();
      if (track) { this.watchTrack(track); this.startLevelMeter(track); }
    });
    call.on("hangup", () => this.stopLevelMeter());
  }
  private watchTrack(track: MediaStreamTrack) {
    track.onended = async () => {
      if (!this.activeCall) return;
      const lost = this.inputDeviceId ?? "default"; this.inputDeviceId = null;
      const recovered = await this.recoverInput();
      this.emit("input-device-lost", { deviceId: lost, label: track.label, recovered } as DeviceLostEvent);
    };
  }

  /** Medidor de nivel del micrófono local (AnalyserNode), evento "audio-level" cada 500 ms. */
  private startLevelMeter(track: MediaStreamTrack) {
    if (this.opts.audioLevel === false) return;
    this.stopLevelMeter();
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      this.levelCtx = new Ctx();
      // Sin gesto de usuario el AudioContext arranca suspendido: se reanuda explícitamente
      this.levelCtx!.resume().catch(() => {});
      const src = this.levelCtx!.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.levelCtx!.createAnalyser(); analyser.fftSize = 512; src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      this.levelTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 3);
        this.emit("audio-level", { level: Math.round(level * 100) / 100, speaking: level > 0.05 } as AudioLevelEvent);
      }, 500);
    } catch { /* sin AudioContext: no hay medidor */ }
  }
  private stopLevelMeter() {
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    if (this.levelCtx) { this.levelCtx.close().catch(() => {}); this.levelCtx = null; }
  }

  /** Llama a otro usuario del MISMO cliente por su identidad (equivalente a callWebrtc de Infobip).
   *  No pasa por Yeti y no se factura; el edge la entrega al navegador donde esa identidad esté registrada. */
  callUser(identity: string, options: { customHeaders?: Record<string, string> } = {}): PhoneCall {
    if (!this.ua || !this.session) throw new Error("No conectado: llama a connect() primero");
    if (this.activeCall) throw new Error("Ya hay una llamada activa (v1: una llamada por sesión)");
    const id = identity.trim();
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(id) || /^\+?\d{7,15}$/.test(id)) throw new Error(`Identidad inválida: ${identity}`);
    const target = UserAgent.makeURI(`sip:${id}@${this.session.sip.realm}`)!;
    // From = usuario SIP propio; el edge toma la identidad que llama del token, no del From.
    const fromUri = new URI("sip", this.session.sip.username, this.session.sip.realm);
    const extraHeaders = Object.entries(options.customHeaders ?? {}).map(([k, v]) => `X-${k.replace(/^X-/i, "")}: ${v}`);
    const inviter = new Inviter(this.ua, target, { params: { fromUri }, extraHeaders, sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    const call = new PhoneCall(inviter, this.audio, id, this.session.sip.username, (q, cid) => this.reportQuality(q, cid), "user");
    call.mediaConstraints = this.mediaConstraints();
    call.ringbackEnabled = this.opts.ringbackTone !== false;
    if (this.opts.resolveOutboundAni !== false) call._aniLookup = (id) => this.fetchOutboundAni(id);
    this.watchCallDevices(call);
    this.activeCall = call;
    call.on("hangup", () => { this.activeCall = null; });
    inviter.invite({
      requestDelegate: {
        onProgress: (resp) => call._onProgress(resp.message.statusCode ?? 0, resp.message.reasonPhrase, !!resp.message.body),
        onReject: (resp) => {
          const code = resp.message.statusCode ?? 0;
          const reason = resp.message.reasonPhrase;
          const cause: HangupCause = code === 480 ? "usuario-no-registrado" : sipCause(code, reason, call.hasRung);
          call._setHangup({ reason: code === 408 ? "timeout" : "rejected", sipCode: code, sipReason: reason, cause, causeText: HANGUP_CAUSE_TEXT[cause] });
          if (code === 480) this.emit("error", { code: "USER_NOT_REGISTERED", detail: `${id} no está conectado` });
        },
      },
    }).catch((e) => { call._setHangup({ reason: "error", sipReason: String(e), cause: "error-interno", causeText: HANGUP_CAUSE_TEXT["error-interno"] }); call.emit("error", e); });
    return call;
  }

  /**
   * Consulta a la plataforma el número presentado en una llamada ya cursada.
   * Responde `resuelto: false` mientras el CDR de la red no está disponible.
   */
  private async fetchOutboundAni(callId: string): Promise<OutboundAniEvent | null> {
    const url = `${this.opts.apiBaseUrl.replace(/\/$/, "")}/v1/rtc/calls/${encodeURIComponent(callId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.resuelto || !d?.ani) return null;
    return { ani: d.ani, cliEnviado: d.cli_enviado ?? null, destino: d.destino ?? null, sipCode: d.sip_code ?? null, callId };
  }

  allowedCli(): string[] { return this.session?.allowed_cli ?? []; }
  isConnected(): boolean { return this.registerer?.state === RegistererState.Registered; }

  // ----------------------------------------------------------------- internos
  private async fetchSession(): Promise<RtcSession> {
    const res = await fetch(`${this.opts.apiBaseUrl.replace(/\/$/, "")}/v1/rtc/session`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (res.status === 401) { this.emit("disconnected", { reason: "token-expired", detail: await res.text() }); throw new Error("Token inválido o expirado"); }
    if (!res.ok) throw new Error(`Token API ${res.status}`);
    return res.json();
  }
  private scheduleExpiry(expiresAt: number) {
    const ms = Math.max(expiresAt * 1000 - Date.now(), 0);
    this.expiryTimer = window.setTimeout(async () => {
      // Sin renovación silenciosa: el CRM del cliente debe pedir un token nuevo a SU backend y crear otro rtc.
      await this.disconnect();
      this.emit("disconnected", { reason: "token-expired" } as DisconnectedEvent);
    }, ms);
  }
  private onTransportDown(err?: Error) {
    if (this.stopping) return;
    if (this.opts.autoReconnect === false) { this.emit("disconnected", { reason: "transport", detail: err?.message }); return; }
    this.emit("reconnecting", { detail: err?.message });
    // Reintento con backoff acotado (1s, 2s, 4s, 8s, 8s...). Reusa la misma credencial (sigue vigente en Redis).
    let attempt = 0;
    const retry = async () => {
      if (this.stopping || !this.ua) return;
      try { await this.ua.reconnect(); await this.registerer?.register(); this.emit("connected", { reconnected: true }); }
      catch (e) { attempt++; window.setTimeout(retry, Math.min(1000 * 2 ** attempt, 8000)); }
    };
    retry();
  }
  private onIncoming(invitation: Invitation) {
    // Llamada entrante: Yeti entregó un DID asignado a esta identidad y el edge la reenvía por WSS.
    if (this.activeCall) { invitation.reject({ statusCode: 486 }).catch(() => {}); return; }
    const from = invitation.remoteIdentity.uri.user ?? "";
    const to = invitation.request.to.uri.user ?? "";
    const identity = invitation.request.getHeader("X-Movatec-Identity") ?? undefined;
    // El edge marca las internas con X-Movatec-Call-Kind: user (y X-Movatec-Caller = identidad que llama)
    const kind: CallKind = invitation.request.getHeader("X-Movatec-Call-Kind") === "user" ? "user" : "phone";
    const caller = kind === "user" ? (invitation.request.getHeader("X-Movatec-Caller") ?? from) : from;
    const call = new PhoneCall(invitation, this.audio, to, caller, (q, id) => this.reportQuality(q, id), kind);
    call.mediaConstraints = this.mediaConstraints();
    call.ringbackEnabled = this.opts.ringbackTone !== false;
    if (this.opts.resolveOutboundAni !== false) call._aniLookup = (id) => this.fetchOutboundAni(id);
    this.watchCallDevices(call);
    this.activeCall = call;
    call.on("hangup", () => { this.activeCall = null; });
    const ev: IncomingCallEvent = { call, to, from: caller, identity, kind };
    this.emit("incoming-webrtc-call", ev);
  }

  private lastReported = 0;
  /** Reporta la calidad a la API (POST /v1/rtc/quality) como máximo cada 4 s; fallos se ignoran. */
  private reportQuality(q: NetworkQuality, callId: string) {
    if (this.opts.reportQuality === false) return;
    const now = Date.now(); if (now - this.lastReported < 4000) return; this.lastReported = now;
    fetch(`${this.opts.apiBaseUrl.replace(/\/$/, "")}/v1/rtc/quality`, { method: "POST", keepalive: true,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: callId, ...q }) }).catch(() => {});
  }
}

/** Fábrica compatible con `createInfobipRtc(token, options)`. */
export function createRtc(token: string, options: RtcOptions): MovatecRTC {
  if (!token || token.split(".").length !== 3) throw new Error("Token JWT inválido");
  return new MovatecRTC(token, options);
}
export default createRtc;
