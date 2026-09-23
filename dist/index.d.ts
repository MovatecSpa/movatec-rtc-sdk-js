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
import { Session } from "sip.js";
export type RtcEvent = "connected" | "disconnected" | "reconnecting" | "incoming-webrtc-call" | "error" | "device-change" | "input-device-lost" | "output-device-lost" | "audio-level";
/** Dispositivo de audio (micrófono o parlante) tal como lo reporta el navegador. */
export interface AudioDevice {
    deviceId: string;
    label: string;
    kind: "audioinput" | "audiooutput";
    isDefault: boolean;
}
export interface DeviceChangeEvent {
    inputs: AudioDevice[];
    outputs: AudioDevice[];
}
export interface DeviceLostEvent {
    deviceId: string;
    label: string;
    recovered: boolean;
}
/** Nivel del micrófono local, 0..1 (RMS normalizado), cada ~500 ms durante la llamada. */
export interface AudioLevelEvent {
    level: number;
    speaking: boolean;
}
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
    /** Número presentado al destino. Es el dato a guardar junto a la gestión. */
    ani: string;
    /**
     * Número que la plataforma eligió del pool del cliente para esta llamada.
     * Si difiere de `ani`, la terminación lo reescribió por su cuenta.
     */
    aniPool: string | null;
    /** "cdr" = confirmado por la red (lo que vio el destino) · "pool" = aún sin confirmar. */
    fuente: "cdr" | "pool" | null;
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
export type HangupCause = "numero-invalido" | "destino-no-habilitado" | "cli-no-permitido" | "empresa-no-habilitada" | "sin-saldo" | "ocupado" | "no-contesta" | "no-disponible" | "rechazada" | "usuario-no-registrado" | "sin-respuesta-red" | "cancelada" | "colgada" | "error-interno";
/** Respuesta provisional recibida (100/180/183). `earlyMedia` = el 183 trae audio de la red. */
export interface ProgressEvent {
    sipCode: number;
    sipReason?: string;
    earlyMedia: boolean;
}
/** Calidad de red medida en el navegador con RTCPeerConnection.getStats() (cada 2 s). score: 5 excelente … 1 inutilizable. */
export interface NetworkQuality {
    score: 1 | 2 | 3 | 4 | 5;
    label: "excelente" | "buena" | "regular" | "mala" | "inutilizable";
    rttMs: number | null;
    jitterMs: number | null;
    packetLossPct: number | null;
    mos: number | null;
    bitrateKbps: number | null;
    candidateType: string | null;
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
    /**
     * Empresa cliente cuya cartera se está gestionando. Determina con qué pool de números se
     * presenta la llamada. Debe estar entre las habilitadas en el token; si se omite, se usa la
     * empresa por defecto del usuario. Sólo aplica si tu cuenta usa separación por empresa.
     */
    account?: string;
    /** SOLO para validación: omite la comprobación local del CLI para que sea el edge quien lo rechace (403). */
    __skipLocalCliCheck?: boolean;
}
export interface DisconnectedEvent {
    reason: "user" | "token-expired" | "transport" | "auth-failed" | "server";
    detail?: string;
}
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
export declare const HANGUP_CAUSE_TEXT: Record<HangupCause, string>;
/**
 * Traduce un codigo SIP a una causa de negocio.
 * `rang` distingue 408/480 "nunca timbro" (problema de red/ruta) de "timbro y no contestaron".
 */
export declare function sipCause(code: number, reason?: string, rang?: boolean): HangupCause;
declare class Emitter<E extends string> {
    private handlers;
    on(event: E, fn: (payload: any) => void): this;
    off(event: E, fn: (payload: any) => void): this;
    /** Público por necesidad (PhoneCall lo usa desde MovatecRTC); no forma parte de la API documentada. */
    emit(event: E, payload?: any): void;
}
export declare class PhoneCall extends Emitter<CallEvent> {
    private session;
    private audio;
    readonly destination: string;
    readonly from: string;
    private onQuality?;
    private muted;
    private startedAt;
    private qualityTimer;
    private lastQuality;
    private prevStats;
    readonly direction: "outbound" | "inbound";
    /** "phone" = por Yeti hacia/desde la red; "user" = interna entre usuarios del mismo cliente. */
    readonly kind: CallKind;
    constructor(session: Session, audio: HTMLAudioElement, destination: string, from: string, onQuality?: ((q: NetworkQuality, callId: string) => void) | undefined, kind?: CallKind);
    private lastHangup;
    /** Número presentado al destino; null hasta que la plataforma lo resuelve (ver evento "outbound-ani"). */
    outboundAni: string | null;
    /** Lo inyecta MovatecRTC: consulta la plataforma por el ANI de este Call-ID. */
    _aniLookup?: (callId: string) => Promise<OutboundAniEvent | null>;
    private ringback;
    private rang;
    private earlyMedia;
    /** Reproducir tono de llamada local mientras timbra. Lo fija MovatecRTC desde RtcOptions. */
    ringbackEnabled: boolean;
    /** true si el destino alcanzó a timbrar (llegó 180 o 183). */
    get hasRung(): boolean;
    /**
     * Uso interno: respuesta provisional de la red (100/180/183).
     * 183 con SDP = audio real de la operadora (locución, tono propio): se engancha ese audio
     * y NO se genera tono local, para no pisar el mensaje que la red está mandando.
     */
    _onProgress(code: number, reason: string | undefined, hasSdp: boolean): void;
    /**
     * Resuelve el número presentado al destino. Se llama solo al terminar la llamada; también
     * puede invocarse a mano. El dato viene del CDR de la red, que tarda unos segundos en estar
     * disponible (medido: < 10 s), así que se reintenta con espera creciente hasta ~25 s.
     * Devuelve null si no se pudo resolver (sin red, llamada que nunca salió, etc.).
     */
    resolveOutboundAni(): Promise<OutboundAniEvent | null>;
    /** Completa el evento de corte con causa legible. */
    private buildHangup;
    /** Restricciones de media para esta llamada (micrófono elegido). Las fija MovatecRTC; default: cualquier micrófono. */
    mediaConstraints: MediaStreamConstraints;
    /** Llamada entrante: contestar (pide micrófono). */
    accept(): Promise<void>;
    /** Pista de audio local que se está enviando (null si aún no hay media). */
    localAudioTrack(): MediaStreamTrack | null;
    /** Cambia el micrófono en caliente: reemplaza la pista enviada (RTCRtpSender.replaceTrack) sin renegociar SIP. */
    replaceAudioTrack(track: MediaStreamTrack): Promise<boolean>;
    /** Llamada entrante: rechazar (486 Busy por defecto). */
    decline(statusCode?: number): Promise<void>;
    /** Última medición de calidad de red (null hasta que la llamada esté establecida). */
    networkQuality(): NetworkQuality | null;
    private startQuality;
    private stopQuality;
    /** Lee getStats() y calcula un puntaje explicable: RTT, jitter y pérdida → MOS (E-model simplificado) → score 1..5. */
    private measure;
    /** Cuelga (o cancela si aún no contestan). */
    hangup(): Promise<void>;
    mute(shouldMute?: boolean): void;
    unmute(): void;
    isMuted(): boolean;
    private onHold;
    /** Pone la llamada en espera: re-INVITE con a=sendonly (SIP.js holdModifier), deja de enviar micrófono y silencia el remoto. */
    hold(): Promise<void>;
    /** Reanuda: re-INVITE con a=sendrecv y vuelve a enviar/recibir audio. */
    resume(): Promise<void>;
    isOnHold(): boolean;
    private setLocalTracks;
    /**
     * Transferencia ciega (REFER). `target`: E.164 (+569…) o identidad de otro usuario del mismo cliente.
     * LIMITACIÓN ACTUAL: Yeti no acepta REFER en el diálogo (su Allow no lo incluye) y el edge no es B2BUA, así que la
     * plataforma responde 501 y se emite `transfer-failed` con ese código. La transferencia real requiere el B2BUA (ver README).
     */
    transfer(target: string): Promise<void>;
    /** DTMF RFC 4733 (out-of-band). `tones` acepta 0-9 * # A-D. */
    sendDTMF(tones: string): boolean;
    duration(): number;
    id(): string;
    /** Call-ID SIP de la llamada (el mismo que ve el panel de operación y Yeti). */
    sipCallId(): string;
    /** Uso interno: fija la razón de corte cuando viene de rechazo/timeout. */
    _setHangup(h: HangupEvent): void;
    private attachRemoteAudio;
}
export declare class MovatecRTC extends Emitter<RtcEvent> {
    private token;
    private opts;
    private ua;
    private registerer;
    private session;
    private audio;
    private expiryTimer;
    private activeCall;
    private stopping;
    constructor(token: string, opts: RtcOptions);
    /** Obtiene credenciales efímeras, conecta el WSS y hace REGISTER. Resuelve al quedar registrado. */
    connect(): Promise<void>;
    /** Cierra sesión: cuelga llamada activa, un-REGISTER y cierra el WSS. */
    disconnect(): Promise<void>;
    /** Origina una llamada a un número E.164 presentando el CLI `from`. */
    callPhone(destination: string, options?: CallPhoneOptions): PhoneCall;
    private inputDeviceId;
    private outputDeviceId;
    private lastDevices;
    private levelTimer;
    private levelCtx;
    /** Micrófonos disponibles. Pide permiso una vez si las etiquetas vienen vacías (el navegador las oculta sin permiso). */
    getAudioInputDevices(): Promise<AudioDevice[]>;
    /** Parlantes disponibles. En navegadores sin setSinkId (Safari/Firefox) la lista puede venir vacía. */
    getAudioOutputDevices(): Promise<AudioDevice[]>;
    /** Dispositivos seleccionados (null = predeterminado del sistema). */
    selectedDevices(): {
        input: string | null;
        output: string | null;
    };
    /** ¿El navegador permite elegir parlante? (HTMLMediaElement.setSinkId) */
    canSelectOutput(): boolean;
    /** Elige el micrófono. Queda para las próximas llamadas y, si hay una activa, se cambia en caliente. */
    setAudioInputDevice(deviceId: string | null): Promise<void>;
    /** Elige el parlante para el audio remoto (setSinkId). Lanza si el navegador no lo soporta. */
    setAudioOutputDevice(deviceId: string | null): Promise<void>;
    private mediaConstraints;
    private enumerate;
    private installDeviceChangeListener;
    /** Con llamada activa y micrófono perdido: intenta el predeterminado (autoRecoverInput, default true). */
    private recoverInput;
    /** Vigila la pista local de la llamada: si termina (micrófono desconectado) avisa e intenta recuperar. */
    private watchCallDevices;
    private watchTrack;
    /** Medidor de nivel del micrófono local (AnalyserNode), evento "audio-level" cada 500 ms. */
    private startLevelMeter;
    private stopLevelMeter;
    /** Llama a otro usuario del MISMO cliente por su identidad (equivalente a callWebrtc de Infobip).
     *  No pasa por Yeti y no se factura; el edge la entrega al navegador donde esa identidad esté registrada. */
    callUser(identity: string, options?: {
        customHeaders?: Record<string, string>;
    }): PhoneCall;
    /**
     * Consulta a la plataforma el número presentado en una llamada ya cursada.
     * Responde `resuelto: false` mientras el CDR de la red no está disponible.
     */
    private fetchOutboundAni;
    allowedCli(): string[];
    /** Empresas cliente habilitadas para este usuario (vacío si tu cuenta no usa separación por empresa). */
    accounts(): string[];
    isConnected(): boolean;
    private fetchSession;
    private scheduleExpiry;
    private onTransportDown;
    private onIncoming;
    private lastReported;
    /** Reporta la calidad a la API (POST /v1/rtc/quality) como máximo cada 4 s; fallos se ignoran. */
    private reportQuality;
}
/** Fábrica compatible con `createInfobipRtc(token, options)`. */
export declare function createRtc(token: string, options: RtcOptions): MovatecRTC;
export default createRtc;
