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
import { Inviter, Invitation, Registerer, RegistererState, SessionState, UserAgent, URI, Web, } from "sip.js";
/** Texto por defecto de cada causa (es-CL). */
export const HANGUP_CAUSE_TEXT = {
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
export function sipCause(code, reason, rang = false) {
    const r = (reason ?? "").toLowerCase();
    if (/balance|credit|saldo|payment|funds/.test(r))
        return "sin-saldo";
    // Yeti responde "404 No routes" cuando el prefijo/pais no esta habilitado en la cuenta:
    // eso NO es un numero mal marcado, es un destino no habilitado. Distinguirlos importa
    // porque la accion del operador es distinta (corregir el numero vs. pedir habilitacion).
    if (/no route|not allowed|forbidden dst|destination/.test(r))
        return "destino-no-habilitado";
    switch (code) {
        case 400:
        case 404:
        case 484:
        case 485: return "numero-invalido";
        case 402: return "sin-saldo";
        case 403: return /cli|caller|from/.test(r) ? "cli-no-permitido" : "destino-no-habilitado";
        case 408: return rang ? "no-contesta" : "sin-respuesta-red";
        case 410: return "numero-invalido";
        case 480: return rang ? "no-contesta" : "no-disponible";
        case 486:
        case 600: return "ocupado";
        case 487: return "cancelada";
        case 503: return "no-disponible";
        case 603: return "rechazada";
        default:
            if (code >= 500 && code < 600)
                return "error-interno";
            if (code >= 400)
                return "rechazada";
            return "colgada";
    }
}
// --------------------------------------------------------------------------- emisor mínimo
class Emitter {
    constructor() {
        this.handlers = new Map();
    }
    on(event, fn) {
        if (!this.handlers.has(event))
            this.handlers.set(event, new Set());
        this.handlers.get(event).add(fn);
        return this;
    }
    off(event, fn) { this.handlers.get(event)?.delete(fn); return this; }
    /** Público por necesidad (PhoneCall lo usa desde MovatecRTC); no forma parte de la API documentada. */
    emit(event, payload) {
        this.handlers.get(event)?.forEach((fn) => { try {
            fn(payload);
        }
        catch (e) {
            console.error("[movatec-rtc] handler error", e);
        } });
    }
}
// --------------------------------------------------------------------------- llamada
/**
 * Tono de llamada generado localmente con WebAudio (no consume red ni depende de que
 * la operadora mande early media). Cadencia chilena por defecto: 400 Hz, 1 s on / 3 s off.
 * Si el navegador bloquea el AudioContext por autoplay, falla en silencio: nunca rompe la llamada.
 */
class Ringback {
    constructor(freqHz = 400, onMs = 1000, offMs = 3000, volume = 0.12) {
        this.freqHz = freqHz;
        this.onMs = onMs;
        this.offMs = offMs;
        this.volume = volume;
        this.ctx = null;
        this.gain = null;
        this.osc = null;
        this.timer = null;
        this.playing = false;
    }
    start(sinkId) {
        if (this.playing)
            return;
        try {
            const Ctx = window.AudioContext ?? window.webkitAudioContext;
            if (!Ctx)
                return;
            this.ctx = new Ctx();
            void this.ctx.resume().catch(() => { });
            this.gain = this.ctx.createGain();
            this.gain.gain.value = 0;
            this.osc = this.ctx.createOscillator();
            this.osc.type = "sine";
            this.osc.frequency.value = this.freqHz;
            this.osc.connect(this.gain);
            this.gain.connect(this.ctx.destination);
            this.osc.start();
            this.playing = true;
            const beep = () => {
                if (!this.ctx || !this.gain)
                    return;
                const t = this.ctx.currentTime;
                // rampas cortas para evitar el "click" de abrir/cerrar la ganancia de golpe
                this.gain.gain.setValueAtTime(0, t);
                this.gain.gain.linearRampToValueAtTime(this.volume, t + 0.02);
                this.gain.gain.setValueAtTime(this.volume, t + this.onMs / 1000 - 0.02);
                this.gain.gain.linearRampToValueAtTime(0, t + this.onMs / 1000);
            };
            beep();
            this.timer = setInterval(beep, this.onMs + this.offMs);
        }
        catch {
            this.stop();
        }
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        try {
            this.osc?.stop();
        }
        catch { }
        try {
            this.gain?.disconnect();
        }
        catch { }
        try {
            void this.ctx?.close();
        }
        catch { }
        this.osc = null;
        this.gain = null;
        this.ctx = null;
        this.playing = false;
    }
}
export class PhoneCall extends Emitter {
    constructor(session, audio, destination, from, onQuality, kind = "phone") {
        super();
        this.session = session;
        this.audio = audio;
        this.destination = destination;
        this.from = from;
        this.onQuality = onQuality;
        this.muted = false;
        this.startedAt = null;
        this.qualityTimer = null;
        this.lastQuality = null;
        this.prevStats = null;
        this.lastHangup = null;
        this.ringback = new Ringback();
        this.rang = false;
        this.earlyMedia = false;
        /** Reproducir tono de llamada local mientras timbra. Lo fija MovatecRTC desde RtcOptions. */
        this.ringbackEnabled = true;
        /** Restricciones de media para esta llamada (micrófono elegido). Las fija MovatecRTC; default: cualquier micrófono. */
        this.mediaConstraints = { audio: true, video: false };
        this.onHold = false;
        this.kind = kind;
        this.direction = session instanceof Invitation ? "inbound" : "outbound";
        session.stateChange.addListener((state) => {
            switch (state) {
                // OJO: SIP.js entra en Establishing al ENVIAR el INVITE, no cuando el destino timbra.
                // Emitir "ringing" aquí era un falso positivo: la llamada "sonaba" aunque la red la
                // hubiera descartado. Ahora esto es "calling" y el "ringing" real sale del 180/183.
                case SessionState.Establishing:
                    this.emit("calling");
                    break;
                case SessionState.Established:
                    this.ringback.stop();
                    this.startedAt = Date.now();
                    this.attachRemoteAudio();
                    this.startQuality();
                    this.emit("established");
                    break;
                // Terminated llega antes que requestDelegate.onReject: se difiere para que el evento traiga el código SIP (p. ej. 403 del edge)
                case SessionState.Terminated:
                    this.ringback.stop();
                    this.stopQuality();
                    setTimeout(() => this.emit("hangup", this.buildHangup()), 0);
                    break;
            }
        });
    }
    /** true si el destino alcanzó a timbrar (llegó 180 o 183). */
    get hasRung() { return this.rang; }
    /**
     * Uso interno: respuesta provisional de la red (100/180/183).
     * 183 con SDP = audio real de la operadora (locución, tono propio): se engancha ese audio
     * y NO se genera tono local, para no pisar el mensaje que la red está mandando.
     */
    _onProgress(code, reason, hasSdp) {
        if (code === 100)
            return; // Trying: la red tomó el INVITE, aún no timbra
        const early = code === 183 && hasSdp;
        this.emit("progress", { sipCode: code, sipReason: reason, earlyMedia: early });
        if (code !== 180 && code !== 183)
            return;
        if (early && !this.earlyMedia) {
            this.earlyMedia = true;
            this.ringback.stop();
            this.attachRemoteAudio();
        }
        if (this.rang)
            return;
        this.rang = true;
        if (!this.earlyMedia && this.ringbackEnabled)
            this.ringback.start();
        this.emit("ringing", { sipCode: code, sipReason: reason, earlyMedia: early });
    }
    /** Completa el evento de corte con causa legible. */
    buildHangup() {
        const h = this.lastHangup ?? { reason: "remote" };
        if (h.cause)
            return { ...h, rang: this.rang };
        const code = h.sipCode ?? 0;
        const cause = h.reason === "local" ? "colgada"
            : code ? sipCause(code, h.sipReason, this.rang)
                : (h.reason === "error" ? "error-interno" : "colgada");
        return { ...h, cause, causeText: HANGUP_CAUSE_TEXT[cause], rang: this.rang };
    }
    /** Llamada entrante: contestar (pide micrófono). */
    async accept() {
        if (!(this.session instanceof Invitation))
            throw new Error("accept() solo aplica a llamadas entrantes");
        await this.session.accept({ sessionDescriptionHandlerOptions: { constraints: this.mediaConstraints } });
    }
    /** Pista de audio local que se está enviando (null si aún no hay media). */
    localAudioTrack() {
        const pc = this.session.sessionDescriptionHandler?.peerConnection;
        return pc?.getSenders().find((sn) => sn.track?.kind === "audio")?.track ?? null;
    }
    /** Cambia el micrófono en caliente: reemplaza la pista enviada (RTCRtpSender.replaceTrack) sin renegociar SIP. */
    async replaceAudioTrack(track) {
        const pc = this.session.sessionDescriptionHandler?.peerConnection;
        const sender = pc?.getSenders().find((sn) => sn.track?.kind === "audio");
        if (!sender)
            return false;
        const old = sender.track;
        await sender.replaceTrack(track);
        track.enabled = !this.muted; // respeta el estado de mute
        old?.stop();
        return true;
    }
    /** Llamada entrante: rechazar (486 Busy por defecto). */
    async decline(statusCode = 486) {
        if (!(this.session instanceof Invitation))
            throw new Error("decline() solo aplica a llamadas entrantes");
        this.lastHangup = { reason: "local" };
        await this.session.reject({ statusCode });
    }
    /** Última medición de calidad de red (null hasta que la llamada esté establecida). */
    networkQuality() { return this.lastQuality; }
    startQuality() {
        this.qualityTimer = window.setInterval(() => this.measure().catch(() => { }), 2000);
    }
    stopQuality() { if (this.qualityTimer) {
        clearInterval(this.qualityTimer);
        this.qualityTimer = null;
    } }
    /** Lee getStats() y calcula un puntaje explicable: RTT, jitter y pérdida → MOS (E-model simplificado) → score 1..5. */
    async measure() {
        const pc = this.session.sessionDescriptionHandler?.peerConnection;
        if (!pc)
            return;
        const stats = await pc.getStats();
        let rtt = null, jitter = null, lost = 0, received = 0, bytes = 0, candidateType = null;
        // Par ICE en uso: primero el que indica "transport" (selectedCandidatePairId); si no, el par nominado/exitoso
        let pairId = null;
        stats.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId)
            pairId = r.selectedCandidatePairId; });
        stats.forEach((r) => {
            if (r.type === "candidate-pair" && ((pairId && r.id === pairId) || (!pairId && (r.nominated || r.selected) && r.state === "succeeded"))) {
                if (r.currentRoundTripTime != null)
                    rtt = r.currentRoundTripTime * 1000;
                else if (r.totalRoundTripTime != null && r.responsesReceived)
                    rtt = (r.totalRoundTripTime / r.responsesReceived) * 1000;
                const local = stats.get(r.localCandidateId);
                if (local?.candidateType)
                    candidateType = local.candidateType;
            }
            if (r.type === "inbound-rtp" && r.kind === "audio") {
                if (r.jitter != null)
                    jitter = r.jitter * 1000;
                lost = r.packetsLost ?? 0;
                received = r.packetsReceived ?? 0;
                bytes = r.bytesReceived ?? 0;
            }
        });
        const now = Date.now();
        let bitrate = null, lossPct = null;
        if (this.prevStats) {
            const dt = (now - this.prevStats.ts) / 1000;
            bitrate = dt > 0 ? Math.round(((bytes - this.prevStats.bytes) * 8) / dt / 1000) : null;
            const dRecv = received - this.prevStats.received, dLost = lost - this.prevStats.lost;
            lossPct = dRecv + dLost > 0 ? Math.round((100 * dLost) / (dRecv + dLost) * 10) / 10 : 0;
        }
        this.prevStats = { ts: now, bytes, lost, received };
        // E-model simplificado (ITU-T G.107): R = 93.2 - Id(rtt) - Ie(loss); MOS desde R.
        let mos = null;
        if (rtt != null || lossPct != null) {
            const d = (rtt ?? 0) / 2 + (jitter ?? 0) * 2 + 20; // retardo efectivo aproximado (ms)
            const Id = d < 160 ? d / 40 : (d - 120) / 10;
            const Ie = 30 * Math.log(1 + 15 * ((lossPct ?? 0) / 100)); // impairment por pérdida (opus/G.711 aprox.)
            const R = Math.max(0, Math.min(100, 93.2 - Id - Ie));
            mos = R < 0 ? 1 : R > 100 ? 4.5 : 1 + 0.035 * R + 7e-6 * R * (R - 60) * (100 - R);
            mos = Math.round(mos * 100) / 100;
        }
        const score = mos == null ? 3 : mos >= 4.0 ? 5 : mos >= 3.6 ? 4 : mos >= 3.1 ? 3 : mos >= 2.6 ? 2 : 1;
        const label = ["inutilizable", "mala", "regular", "buena", "excelente"][score - 1];
        const q = { score, label, rttMs: rtt != null ? Math.round(rtt) : null, jitterMs: jitter != null ? Math.round(jitter) : null,
            packetLossPct: lossPct, mos, bitrateKbps: bitrate, candidateType };
        const changed = !this.lastQuality || this.lastQuality.score !== q.score;
        this.lastQuality = q;
        this.emit("network-quality", { ...q, changed });
        // Se reporta con el Call-ID SIP real (no el id interno de SIP.js) para que el panel lo correlacione con la llamada
        this.onQuality?.(q, this.sipCallId());
    }
    /** Cuelga (o cancela si aún no contestan). */
    async hangup() {
        this.lastHangup = { reason: "local" };
        const s = this.session;
        if (s.state === SessionState.Initial || s.state === SessionState.Establishing) {
            if (s instanceof Inviter)
                await s.cancel();
            else if (s instanceof Invitation)
                await s.reject();
        }
        else if (s.state === SessionState.Established) {
            await s.bye();
        }
    }
    mute(shouldMute = true) {
        const pc = this.session.sessionDescriptionHandler?.peerConnection;
        pc?.getSenders().forEach((snd) => { if (snd.track?.kind === "audio")
            snd.track.enabled = !shouldMute; });
        this.muted = shouldMute;
        this.emit(shouldMute ? "muted" : "unmuted");
    }
    unmute() { this.mute(false); }
    isMuted() { return this.muted; }
    /** Pone la llamada en espera: re-INVITE con a=sendonly (SIP.js holdModifier), deja de enviar micrófono y silencia el remoto. */
    async hold() {
        if (this.session.state !== SessionState.Established)
            throw new Error("hold() solo con la llamada establecida");
        if (this.onHold)
            return;
        await this.session.invite({ sessionDescriptionHandlerModifiers: [Web.holdModifier] });
        this.setLocalTracks(false);
        this.audio.muted = true;
        this.onHold = true;
        this.emit("hold");
    }
    /** Reanuda: re-INVITE con a=sendrecv y vuelve a enviar/recibir audio. */
    async resume() {
        if (!this.onHold)
            return;
        await this.session.invite({ sessionDescriptionHandlerModifiers: [] });
        this.setLocalTracks(!this.muted);
        this.audio.muted = false;
        this.onHold = false;
        this.emit("resume");
    }
    isOnHold() { return this.onHold; }
    setLocalTracks(enabled) {
        const pc = this.session.sessionDescriptionHandler?.peerConnection;
        pc?.getSenders().forEach((snd) => { if (snd.track?.kind === "audio")
            snd.track.enabled = enabled; });
    }
    /**
     * Transferencia ciega (REFER). `target`: E.164 (+569…) o identidad de otro usuario del mismo cliente.
     * LIMITACIÓN ACTUAL: Yeti no acepta REFER en el diálogo (su Allow no lo incluye) y el edge no es B2BUA, así que la
     * plataforma responde 501 y se emite `transfer-failed` con ese código. La transferencia real requiere el B2BUA (ver README).
     */
    async transfer(target) {
        if (this.session.state !== SessionState.Established)
            throw new Error("transfer() solo con la llamada establecida");
        const realm = this.session.userAgent.configuration.uri?.host ?? "rtc.movatec.cl";
        const own = this.session.userAgent.configuration.uri?.user ?? ""; // t<tenant>.<identidad>.<hex>
        const tenant = own.startsWith("t") ? own.slice(1).split(".")[0] : "";
        const dst = target.replace(/[\s().-]/g, "");
        const uriStr = /^\+[1-9]\d{6,14}$/.test(dst) ? `sip:${dst}@${realm}` : /^[A-Za-z0-9._@-]+$/.test(target) ? `sip:${tenant}.${target}@${realm}` : "";
        if (!uriStr)
            throw new Error(`destino de transferencia inválido: ${target}`);
        const uri = UserAgent.makeURI(uriStr);
        await this.session.refer(uri, {
            requestDelegate: {
                onAccept: (r) => this.emit("transfer-accepted", { target: uriStr, sipCode: r.message.statusCode }),
                onReject: (r) => this.emit("transfer-failed", { target: uriStr, sipCode: r.message.statusCode, sipReason: r.message.reasonPhrase }),
            },
        });
    }
    /** DTMF RFC 4733 (out-of-band). `tones` acepta 0-9 * # A-D. */
    sendDTMF(tones) {
        if (!/^[0-9A-D*#]+$/i.test(tones))
            throw new Error("DTMF inválido");
        const sdh = this.session.sessionDescriptionHandler;
        return sdh?.sendDtmf(tones) ?? false;
    }
    duration() { return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0; }
    id() { return this.session.id; }
    /** Call-ID SIP de la llamada (el mismo que ve el panel de operación y Yeti). */
    sipCallId() { return this.session.request?.callId ?? this.session.id; }
    /** Uso interno: fija la razón de corte cuando viene de rechazo/timeout. */
    _setHangup(h) { this.lastHangup = h; }
    attachRemoteAudio() {
        const sdh = this.session.sessionDescriptionHandler;
        const pc = sdh?.peerConnection;
        if (!pc)
            return;
        const stream = new MediaStream();
        pc.getReceivers().forEach((r) => { if (r.track)
            stream.addTrack(r.track); });
        this.audio.srcObject = stream;
        this.audio.play().catch((e) => console.warn("[movatec-rtc] autoplay bloqueado", e));
    }
}
// --------------------------------------------------------------------------- cliente
export class MovatecRTC extends Emitter {
    constructor(token, opts) {
        super();
        this.token = token;
        this.opts = opts;
        this.ua = null;
        this.registerer = null;
        this.session = null;
        this.expiryTimer = null;
        this.activeCall = null;
        this.stopping = false;
        // ------------------------------------------------------------------ dispositivos de audio
        this.inputDeviceId = null;
        this.outputDeviceId = null;
        this.lastDevices = { inputs: [], outputs: [] };
        this.levelTimer = null;
        this.levelCtx = null;
        this.lastReported = 0;
        this.audio = opts.audioElement ?? Object.assign(document.createElement("audio"), { autoplay: true, hidden: true });
        if (!opts.audioElement)
            document.body.appendChild(this.audio);
        this.inputDeviceId = opts.audioInputDeviceId ?? null;
        if (opts.audioOutputDeviceId)
            this.setAudioOutputDevice(opts.audioOutputDeviceId).catch(() => { });
        this.installDeviceChangeListener();
    }
    /** Obtiene credenciales efímeras, conecta el WSS y hace REGISTER. Resuelve al quedar registrado. */
    async connect() {
        this.stopping = false;
        this.session = await this.fetchSession();
        const s = this.session;
        const uri = UserAgent.makeURI(`sip:${s.sip.username}@${s.sip.realm}`);
        if (!uri)
            throw new Error("URI SIP inválida");
        const uaOptions = {
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
        await new Promise((resolve, reject) => {
            const reg = this.registerer;
            const listener = (st) => {
                if (st === RegistererState.Registered) {
                    reg.stateChange.removeListener(listener);
                    resolve();
                }
                if (st === RegistererState.Terminated) {
                    reg.stateChange.removeListener(listener);
                    reject(new Error("REGISTER terminado"));
                }
            };
            reg.stateChange.addListener(listener);
            reg.register({
                requestDelegate: {
                    onReject: (resp) => {
                        reg.stateChange.removeListener(listener);
                        const code = resp.message.statusCode;
                        this.emit("disconnected", { reason: code === 401 || code === 403 ? "auth-failed" : "server", detail: `${code} ${resp.message.reasonPhrase}` });
                        reject(new Error(`REGISTER rechazado: ${code}`));
                    },
                },
            }).catch(reject);
        });
        this.scheduleExpiry(s.sip.expires_at);
        this.emit("connected", { identity: s.sip.username, allowedCli: s.allowed_cli, capabilities: s.capabilities });
    }
    /** Cierra sesión: cuelga llamada activa, un-REGISTER y cierra el WSS. */
    async disconnect() {
        this.stopping = true;
        if (this.expiryTimer) {
            clearTimeout(this.expiryTimer);
            this.expiryTimer = null;
        }
        try {
            await this.activeCall?.hangup();
        }
        catch { /* ya cortada */ }
        try {
            await this.registerer?.unregister();
        }
        catch { /* transporte caído */ }
        try {
            await this.ua?.stop();
        }
        catch { /* idem */ }
        this.ua = null;
        this.registerer = null;
        this.emit("disconnected", { reason: "user" });
    }
    /** Origina una llamada a un número E.164 presentando el CLI `from`. */
    callPhone(destination, options = {}) {
        if (!this.ua || !this.session)
            throw new Error("No conectado: llama a connect() primero");
        if (this.activeCall)
            throw new Error("Ya hay una llamada activa (v1: una llamada por sesión)");
        const dst = destination.replace(/[\s().-]/g, "");
        if (!/^\+[1-9]\d{6,14}$/.test(dst))
            throw new Error(`Destino no E.164: ${destination}`);
        const from = options.from ?? this.session.default_cli ?? undefined;
        if (!from)
            throw new Error("No hay CLI disponible para este usuario");
        if (!options.__skipLocalCliCheck && !this.session.allowed_cli.includes(from))
            throw new Error(`CLI ${from} no permitido para este usuario`);
        const target = UserAgent.makeURI(`sip:${dst}@${this.session.sip.realm}`);
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
                    if (code === 403)
                        this.emit("error", { code: "CLI_NOT_ALLOWED_OR_FRAUD_CONTROL", detail: reason });
                },
            },
        }).catch((e) => { call._setHangup({ reason: "error", sipReason: String(e), cause: "error-interno", causeText: HANGUP_CAUSE_TEXT["error-interno"] }); call.emit("error", e); });
        return call;
    }
    /** Micrófonos disponibles. Pide permiso una vez si las etiquetas vienen vacías (el navegador las oculta sin permiso). */
    async getAudioInputDevices() { return (await this.enumerate()).inputs; }
    /** Parlantes disponibles. En navegadores sin setSinkId (Safari/Firefox) la lista puede venir vacía. */
    async getAudioOutputDevices() { return (await this.enumerate()).outputs; }
    /** Dispositivos seleccionados (null = predeterminado del sistema). */
    selectedDevices() { return { input: this.inputDeviceId, output: this.outputDeviceId }; }
    /** ¿El navegador permite elegir parlante? (HTMLMediaElement.setSinkId) */
    canSelectOutput() { return typeof this.audio.setSinkId === "function"; }
    /** Elige el micrófono. Queda para las próximas llamadas y, si hay una activa, se cambia en caliente. */
    async setAudioInputDevice(deviceId) {
        this.inputDeviceId = deviceId || null;
        if (!this.activeCall)
            return;
        const stream = await navigator.mediaDevices.getUserMedia(this.mediaConstraints());
        const track = stream.getAudioTracks()[0];
        const ok = await this.activeCall.replaceAudioTrack(track);
        if (!ok) {
            track.stop();
            return;
        }
        this.watchTrack(track);
        this.startLevelMeter(track);
    }
    /** Elige el parlante para el audio remoto (setSinkId). Lanza si el navegador no lo soporta. */
    async setAudioOutputDevice(deviceId) {
        if (!this.canSelectOutput())
            throw new Error("Este navegador no permite elegir parlante (setSinkId)");
        await this.audio.setSinkId(deviceId || "");
        this.outputDeviceId = deviceId || null;
    }
    mediaConstraints() {
        return { audio: this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : true, video: false };
    }
    async enumerate() {
        let list = await navigator.mediaDevices.enumerateDevices();
        if (list.some((d) => d.kind === "audioinput" && !d.label)) {
            // Sin permiso el navegador no entrega etiquetas: se pide una vez y se libera el micrófono
            try {
                const st = await navigator.mediaDevices.getUserMedia({ audio: true });
                st.getTracks().forEach((t) => t.stop());
                list = await navigator.mediaDevices.enumerateDevices();
            }
            catch { /* sin permiso: se devuelve la lista sin etiquetas */ }
        }
        const map = (d) => ({ deviceId: d.deviceId, label: d.label || (d.kind === "audioinput" ? "Micrófono" : "Parlante"), kind: d.kind, isDefault: d.deviceId === "default" });
        this.lastDevices = { inputs: list.filter((d) => d.kind === "audioinput").map(map), outputs: list.filter((d) => d.kind === "audiooutput").map(map) };
        return this.lastDevices;
    }
    installDeviceChangeListener() {
        if (!navigator.mediaDevices?.addEventListener)
            return;
        navigator.mediaDevices.addEventListener("devicechange", async () => {
            const devs = await this.enumerate();
            this.emit("device-change", devs);
            // ¿desapareció el micrófono elegido?
            if (this.inputDeviceId && !devs.inputs.some((d) => d.deviceId === this.inputDeviceId)) {
                const lost = this.inputDeviceId;
                this.inputDeviceId = null;
                const recovered = await this.recoverInput();
                this.emit("input-device-lost", { deviceId: lost, label: "", recovered });
            }
            // ¿desapareció el parlante elegido? → volver al predeterminado
            if (this.outputDeviceId && !devs.outputs.some((d) => d.deviceId === this.outputDeviceId)) {
                const lost = this.outputDeviceId;
                this.outputDeviceId = null;
                let recovered = false;
                try {
                    await this.audio.setSinkId("");
                    recovered = true;
                }
                catch { /* sin soporte */ }
                this.emit("output-device-lost", { deviceId: lost, label: "", recovered });
            }
        });
    }
    /** Con llamada activa y micrófono perdido: intenta el predeterminado (autoRecoverInput, default true). */
    async recoverInput() {
        if (this.opts.autoRecoverInput === false || !this.activeCall)
            return false;
        try {
            await this.setAudioInputDevice(null);
            return true;
        }
        catch {
            return false;
        }
    }
    /** Vigila la pista local de la llamada: si termina (micrófono desconectado) avisa e intenta recuperar. */
    watchCallDevices(call) {
        call.on("established", () => {
            const track = call.localAudioTrack();
            if (track) {
                this.watchTrack(track);
                this.startLevelMeter(track);
            }
        });
        call.on("hangup", () => this.stopLevelMeter());
    }
    watchTrack(track) {
        track.onended = async () => {
            if (!this.activeCall)
                return;
            const lost = this.inputDeviceId ?? "default";
            this.inputDeviceId = null;
            const recovered = await this.recoverInput();
            this.emit("input-device-lost", { deviceId: lost, label: track.label, recovered });
        };
    }
    /** Medidor de nivel del micrófono local (AnalyserNode), evento "audio-level" cada 500 ms. */
    startLevelMeter(track) {
        if (this.opts.audioLevel === false)
            return;
        this.stopLevelMeter();
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx)
                return;
            this.levelCtx = new Ctx();
            // Sin gesto de usuario el AudioContext arranca suspendido: se reanuda explícitamente
            this.levelCtx.resume().catch(() => { });
            const src = this.levelCtx.createMediaStreamSource(new MediaStream([track]));
            const analyser = this.levelCtx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            const buf = new Uint8Array(analyser.fftSize);
            this.levelTimer = window.setInterval(() => {
                analyser.getByteTimeDomainData(buf);
                let sum = 0;
                for (let i = 0; i < buf.length; i++) {
                    const v = (buf[i] - 128) / 128;
                    sum += v * v;
                }
                const level = Math.min(1, Math.sqrt(sum / buf.length) * 3);
                this.emit("audio-level", { level: Math.round(level * 100) / 100, speaking: level > 0.05 });
            }, 500);
        }
        catch { /* sin AudioContext: no hay medidor */ }
    }
    stopLevelMeter() {
        if (this.levelTimer) {
            clearInterval(this.levelTimer);
            this.levelTimer = null;
        }
        if (this.levelCtx) {
            this.levelCtx.close().catch(() => { });
            this.levelCtx = null;
        }
    }
    /** Llama a otro usuario del MISMO cliente por su identidad (equivalente a callWebrtc de Infobip).
     *  No pasa por Yeti y no se factura; el edge la entrega al navegador donde esa identidad esté registrada. */
    callUser(identity, options = {}) {
        if (!this.ua || !this.session)
            throw new Error("No conectado: llama a connect() primero");
        if (this.activeCall)
            throw new Error("Ya hay una llamada activa (v1: una llamada por sesión)");
        const id = identity.trim();
        if (!/^[A-Za-z0-9._@-]{1,64}$/.test(id) || /^\+?\d{7,15}$/.test(id))
            throw new Error(`Identidad inválida: ${identity}`);
        const target = UserAgent.makeURI(`sip:${id}@${this.session.sip.realm}`);
        // From = usuario SIP propio; el edge toma la identidad que llama del token, no del From.
        const fromUri = new URI("sip", this.session.sip.username, this.session.sip.realm);
        const extraHeaders = Object.entries(options.customHeaders ?? {}).map(([k, v]) => `X-${k.replace(/^X-/i, "")}: ${v}`);
        const inviter = new Inviter(this.ua, target, { params: { fromUri }, extraHeaders, sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
        const call = new PhoneCall(inviter, this.audio, id, this.session.sip.username, (q, cid) => this.reportQuality(q, cid), "user");
        call.mediaConstraints = this.mediaConstraints();
        call.ringbackEnabled = this.opts.ringbackTone !== false;
        this.watchCallDevices(call);
        this.activeCall = call;
        call.on("hangup", () => { this.activeCall = null; });
        inviter.invite({
            requestDelegate: {
                onProgress: (resp) => call._onProgress(resp.message.statusCode ?? 0, resp.message.reasonPhrase, !!resp.message.body),
                onReject: (resp) => {
                    const code = resp.message.statusCode ?? 0;
                    const reason = resp.message.reasonPhrase;
                    const cause = code === 480 ? "usuario-no-registrado" : sipCause(code, reason, call.hasRung);
                    call._setHangup({ reason: code === 408 ? "timeout" : "rejected", sipCode: code, sipReason: reason, cause, causeText: HANGUP_CAUSE_TEXT[cause] });
                    if (code === 480)
                        this.emit("error", { code: "USER_NOT_REGISTERED", detail: `${id} no está conectado` });
                },
            },
        }).catch((e) => { call._setHangup({ reason: "error", sipReason: String(e), cause: "error-interno", causeText: HANGUP_CAUSE_TEXT["error-interno"] }); call.emit("error", e); });
        return call;
    }
    allowedCli() { return this.session?.allowed_cli ?? []; }
    isConnected() { return this.registerer?.state === RegistererState.Registered; }
    // ----------------------------------------------------------------- internos
    async fetchSession() {
        const res = await fetch(`${this.opts.apiBaseUrl.replace(/\/$/, "")}/v1/rtc/session`, {
            headers: { Authorization: `Bearer ${this.token}` },
        });
        if (res.status === 401) {
            this.emit("disconnected", { reason: "token-expired", detail: await res.text() });
            throw new Error("Token inválido o expirado");
        }
        if (!res.ok)
            throw new Error(`Token API ${res.status}`);
        return res.json();
    }
    scheduleExpiry(expiresAt) {
        const ms = Math.max(expiresAt * 1000 - Date.now(), 0);
        this.expiryTimer = window.setTimeout(async () => {
            // Sin renovación silenciosa: el CRM del cliente debe pedir un token nuevo a SU backend y crear otro rtc.
            await this.disconnect();
            this.emit("disconnected", { reason: "token-expired" });
        }, ms);
    }
    onTransportDown(err) {
        if (this.stopping)
            return;
        if (this.opts.autoReconnect === false) {
            this.emit("disconnected", { reason: "transport", detail: err?.message });
            return;
        }
        this.emit("reconnecting", { detail: err?.message });
        // Reintento con backoff acotado (1s, 2s, 4s, 8s, 8s...). Reusa la misma credencial (sigue vigente en Redis).
        let attempt = 0;
        const retry = async () => {
            if (this.stopping || !this.ua)
                return;
            try {
                await this.ua.reconnect();
                await this.registerer?.register();
                this.emit("connected", { reconnected: true });
            }
            catch (e) {
                attempt++;
                window.setTimeout(retry, Math.min(1000 * 2 ** attempt, 8000));
            }
        };
        retry();
    }
    onIncoming(invitation) {
        // Llamada entrante: Yeti entregó un DID asignado a esta identidad y el edge la reenvía por WSS.
        if (this.activeCall) {
            invitation.reject({ statusCode: 486 }).catch(() => { });
            return;
        }
        const from = invitation.remoteIdentity.uri.user ?? "";
        const to = invitation.request.to.uri.user ?? "";
        const identity = invitation.request.getHeader("X-Movatec-Identity") ?? undefined;
        // El edge marca las internas con X-Movatec-Call-Kind: user (y X-Movatec-Caller = identidad que llama)
        const kind = invitation.request.getHeader("X-Movatec-Call-Kind") === "user" ? "user" : "phone";
        const caller = kind === "user" ? (invitation.request.getHeader("X-Movatec-Caller") ?? from) : from;
        const call = new PhoneCall(invitation, this.audio, to, caller, (q, id) => this.reportQuality(q, id), kind);
        call.mediaConstraints = this.mediaConstraints();
        call.ringbackEnabled = this.opts.ringbackTone !== false;
        this.watchCallDevices(call);
        this.activeCall = call;
        call.on("hangup", () => { this.activeCall = null; });
        const ev = { call, to, from: caller, identity, kind };
        this.emit("incoming-webrtc-call", ev);
    }
    /** Reporta la calidad a la API (POST /v1/rtc/quality) como máximo cada 4 s; fallos se ignoran. */
    reportQuality(q, callId) {
        if (this.opts.reportQuality === false)
            return;
        const now = Date.now();
        if (now - this.lastReported < 4000)
            return;
        this.lastReported = now;
        fetch(`${this.opts.apiBaseUrl.replace(/\/$/, "")}/v1/rtc/quality`, { method: "POST", keepalive: true,
            headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ call_id: callId, ...q }) }).catch(() => { });
    }
}
/** Fábrica compatible con `createInfobipRtc(token, options)`. */
export function createRtc(token, options) {
    if (!token || token.split(".").length !== 3)
        throw new Error("Token JWT inválido");
    return new MovatecRTC(token, options);
}
export default createRtc;
