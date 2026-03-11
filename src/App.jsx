import { useState, useEffect, useRef, useCallback } from "react";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon   from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { IndexeddbPersistence } from "y-indexeddb";
import { pipeline, env } from "@xenova/transformers";

/* ── Transformers.js config ─────────────────────────────────────────── */
env.allowLocalModels = false;

/* ── Fix Leaflet default marker icon bug ───────────────────────────── */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl:       markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl:     markerShadow,
});

/* ═══════════════════════════════════════════════════════════════════
   SURVIVAL PACKET — 28-byte binary encoder
   ═══════════════════════════════════════════════════════════════════ */
class SurvivalPacket {
  static TYPE_CODES = { safe: 0, danger: 1, resource: 2, unknown: 3 };
  static NEED_CODES = { water: 1, food: 2, medical: 4, shelter: 8 };

  static encode(nodeId, lat, lng, status, type, needs = []) {
    const buffer = new ArrayBuffer(28);
    const view   = new DataView(buffer);
    view.setUint32(0,  parseInt(nodeId, 16));
    view.setInt32(4,   Math.round(lat * 1e6));
    view.setInt32(8,   Math.round(lng * 1e6));
    view.setUint32(12, Math.floor(Date.now() / 1000));
    let flags = 0;
    flags |= (this.TYPE_CODES[type] ?? 3) & 0x3;
    needs.forEach(need => { flags |= (this.NEED_CODES[need] ?? 0) << 4; });
    view.setUint32(16, flags);
    view.setUint32(20, 0);
    view.setUint32(24, 0);
    return buffer;
  }

  static toHexString(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
  }
}

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */
const nowZ = () => new Date().toISOString().slice(11, 19) + "Z";

const classifyMessageFallback = (text) => {
  const t = text.toLowerCase();
  if (/bomb|explosion|attack|danger|fire|threat|armed|hostile|shot|blast/.test(t)) return "danger";
  if (/food|water|medical|medicine|help|supplies|camp|aid|rescue|doctor|hospital|hungry|hurt|injured/.test(t)) return "resource";
  return "safe";
};

const detectNeedsFallback = (text) => {
  const t = text.toLowerCase();
  const needs = [];
  if (/water/.test(t))                       needs.push("water");
  if (/food|hungry/.test(t))                 needs.push("food");
  if (/medical|injured|hurt|doctor/.test(t)) needs.push("medical");
  if (/shelter|roof|housing/.test(t))        needs.push("shelter");
  return needs;
};

const nodeColor = (type) => {
  if (type === "danger")   return "#FF2D55";
  if (type === "resource") return "#00D4FF";
  return "#00FF94";
};

const typeLabel = (type) => {
  if (type === "danger")   return "DANGER";
  if (type === "resource") return "RESOURCE";
  return "SAFE";
};

/* Render the intel text with colored sections */
function IntelTextRenderer({ text }) {
  if (!text) return null;
  return (
    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, lineHeight: 1.75 }}>
      {text.split("\n").map((line, i) => {
        const isSeparator = /^─+$/.test(line.trim());
        const isHeader    = /^\[.+\]$/.test(line.trim());
        const isTitle     = line.includes("GHOSTNET") || line.includes("◈");
        let color = "var(--text)";
        if (isSeparator) color = "rgba(74,74,106,0.5)";
        else if (isHeader) color = "var(--green)";
        else if (isTitle)  color = "var(--cyan)";
        return (
          <div key={i} style={{ color, letterSpacing: isHeader ? "0.08em" : "0.02em" }}>
            {line || "\u00A0"}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAP CHILD COMPONENTS
   ═══════════════════════════════════════════════════════════════════ */
function MapInvalidator() {
  const map = useMap();
  useEffect(() => { setTimeout(() => map.invalidateSize(), 120); }, [map]);
  return null;
}

function MapController({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.flyTo(center, 12, { duration: 2 });
  }, [center, map]);
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   MESH DOTS
   ═══════════════════════════════════════════════════════════════════ */
function MeshDots({ filled, total = 5 }) {
  const clamp = Math.min(Math.max(filled, 0), total);
  return (
    <div className="topbar-center">
      <span className="mesh-label">MESH</span>
      <div className="mesh-dots">
        {Array.from({ length: total }).map((_, i) =>
          i < clamp
            ? <span key={i} className="dot-filled">●</span>
            : <span key={i} className="dot-empty">○</span>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PACKET LOG ENTRY
   ═══════════════════════════════════════════════════════════════════ */
function LogEntry({ time, direction, hex, status, type, signed }) {
  const dirColor  = direction === "TX" ? "var(--green)" : "var(--cyan)";
  const typeColor = nodeColor(type || "safe");
  const sigColor  = signed ? "rgba(0,255,148,0.45)" : "rgba(255,107,53,0.5)";
  return (
    <div className="log-entry">
      <span className="log-ts">{time}</span>
      <span className="log-type" style={{ color: dirColor }}>[{direction}]</span>
      <span style={{ fontSize: 8, color: sigColor, flexShrink: 0 }}>
        {signed ? "🔐" : "⚠"}
      </span>
      <span className="log-hash">{hex}</span>
      <span className="log-badge" style={{ color: typeColor }}>● {status}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   GHOST MAP
   ═══════════════════════════════════════════════════════════════════ */
function GhostMap({ networkNodes, nodeId, userLocation }) {
  return (
    <MapContainer
      center={[20.5937, 78.9629]}
      zoom={5}
      style={{ width: "100%", height: "100%" }}
      zoomControl={true}
      attributionControl={true}
    >
      <MapInvalidator />
      <MapController center={userLocation} />
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution="&copy; OpenStreetMap &copy; CARTO"
        subdomains="abcd"
        maxZoom={19}
      />
      {Object.values(networkNodes).map((node) => {
        if (!node || node.lat == null || node.lng == null) return null;
        const isSelf     = node.id === nodeId;
        const verified   = isSelf || node.verified;
        const typeClr    = nodeColor(node.type);
        const borderClr  = !verified ? "#FF6B35" : typeClr;
        return (
          <CircleMarker
            key={node.id}
            center={[node.lat, node.lng]}
            radius={isSelf ? 14 : 10}
            pathOptions={{
              color:       borderClr,
              fillColor:   typeClr,
              fillOpacity: verified ? 0.3 : 0.1,
              weight:      isSelf ? 2.5 : 2,
              dashArray:   verified ? null : "4 4",
            }}
          >
            <Popup>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: borderClr }}>
                {isSelf ? "◈ YOU" : `◈ NODE ${node.id}`}
              </span>
              <br />
              {!isSelf && (
                <><span style={{ color: verified ? "#00FF94" : "#FF6B35", fontSize: 9 }}>
                  {verified ? "◈ VERIFIED — ECDSA P-256" : "⚠ UNVERIFIED PACKET"}
                </span><br /></>
              )}
              {node.locationReal && (
                <><span style={{ color: "#00FF94", fontSize: 9 }}>● GPS ± {node.accuracy}m</span><br /></>
              )}
              <span style={{ color: "#E8E8F0", fontSize: 10 }}>{node.message || "● ONLINE"}</span>
              <br />
              <span style={{ color: "#4A4A6A", fontSize: 9 }}>
                {new Date(node.timestamp).toISOString().slice(11, 19)}Z
              </span>
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   APP
   ═══════════════════════════════════════════════════════════════════ */
export default function App() {
  /* ── Identity ── */
  const [nodeId] = useState(() =>
    Math.random().toString(16).slice(2, 6).toUpperCase()
  );

  /* ── Core state ── */
  const [blackout,        setBlackout]        = useState(false);
  const [queuedPackets,   setQueuedPackets]   = useState([]);
  const [syncingPackets,  setSyncingPackets]  = useState(false);
  const [blackoutBanner,  setBlackoutBanner]  = useState(null); // 'blackout' | 'restored' | null
  const [message,         setMessage]         = useState("");
  const [networkNodes,    setNetworkNodes]    = useState({});
  const [peerCount,       setPeerCount]       = useState(1);
  const [packetLog,       setPacketLog]       = useState([]);
  const [syncStatus,      setSyncStatus]      = useState("CONNECTING");
  const [userLocation,    setUserLocation]    = useState(null);
  const [gpsStatus,       setGpsStatus]       = useState("PENDING");
  const [gpsAccuracy,     setGpsAccuracy]     = useState(null);

  /* ── AI state ── */
  const [localAIReady,   setLocalAIReady]   = useState(false);
  const [localAILoading, setLocalAILoading] = useState(false);
  const [intelText,      setIntelText]      = useState("");
  const [intelSource,    setIntelSource]    = useState(null); // 'CLOUD_AI' | 'LOCAL_AI' | null
  const [isSynthesizing, setIsSynthesizing] = useState(false);

  /* ── Family Trace state ── */
  const [familyInputs,  setFamilyInputs]  = useState([""]);
  const [familyMatches, setFamilyMatches] = useState({});   // hash -> { node, ts }
  const [tracing,       setTracing]       = useState(false);
  const familyWatchlistRef = useRef(new Map()); // hash -> original input string
  const [cryptoKeys,      setCryptoKeys]      = useState(null);
  const [securityStatus,  setSecurityStatus]  = useState("GENERATING"); // GENERATING | SECURED | UNSECURED

  /* ── Refs ── */
  const ydocRef        = useRef(new Y.Doc());
  const nodesMapRef    = useRef(null);
  const providerRef    = useRef(null);
  const classifierRef  = useRef(null);
  const languageRef    = useRef(null);
  const prevMsgCount   = useRef(0);
  const blackoutRef    = useRef(false); // mirror of blackout for async closures
  const cryptoKeysRef  = useRef(null);  // mirror of cryptoKeys for use in observer closures

  /* ═══════════════════════════════════════════════════════════════
     TIER 2 — On-device AI (Transformers.js)
     ═══════════════════════════════════════════════════════════════ */
  const loadLocalAI = useCallback(async () => {
    setLocalAILoading(true);
    try {
      classifierRef.current = await pipeline(
        "zero-shot-classification",
        "Xenova/mobilebert-uncased-mnli",
        { quantized: true }
      );
      languageRef.current = await pipeline(
        "text-classification",
        "Xenova/lang-detect",
        { quantized: true }
      );
      setLocalAIReady(true);
    } catch (e) {
      console.log("Local AI load failed:", e);
    }
    setLocalAILoading(false);
  }, []);

  const parseWithLocalAI = useCallback(async (msg) => {
    if (!classifierRef.current) return null;
    try {
      const typeResult = await classifierRef.current(
        msg,
        ["danger and threat", "food water medical resources", "safe and secure"],
        { multi_label: false }
      );
      const topLabel = typeResult.labels[0];
      const type = topLabel.includes("danger")
        ? "danger"
        : topLabel.includes("food")
          ? "resource"
          : "safe";

      const needsResult = await classifierRef.current(
        msg,
        ["needs water", "needs food", "needs medical help", "needs shelter"],
        { multi_label: true }
      );
      const needs = needsResult.labels
        .filter((_, i) => needsResult.scores[i] > 0.6)
        .map(l => l.replace("needs ", "").split(" ")[0]);

      let language = "unknown";
      if (languageRef.current) {
        const langResult = await languageRef.current(msg);
        language = langResult[0].label;
      }

      return { type, needs, language, source: "LOCAL_AI" };
    } catch (e) {
      return null;
    }
  }, []);

  const generateLocalIntel = useCallback(async (nodes) => {
    const activeNodes   = Object.values(nodes).filter(n => n && n.message);
    if (!activeNodes.length) return;

    const dangerNodes   = activeNodes.filter(n => n.type === "danger");
    const resourceNodes = activeNodes.filter(n => n.type === "resource");
    const safeNodes     = activeNodes.filter(n => n.type === "safe");

    const brief =
`─────────────────────────────
GHOSTNET LOCAL INTEL — ${nowZ()}
◈ ON-DEVICE AI ACTIVE — BLACKOUT MODE
─────────────────────────────
[THREAT ASSESSMENT]
${dangerNodes.length > 0
  ? `${dangerNodes.length} DANGER SIGNAL${dangerNodes.length > 1 ? "S" : ""} DETECTED IN MESH`
  : "NO ACTIVE THREATS DETECTED"}

[RESOURCES]
${resourceNodes.length > 0
  ? `${resourceNodes.length} RESOURCE NODE${resourceNodes.length > 1 ? "S" : ""} CONFIRMED`
  : "NO RESOURCES REPORTED"}

[ACTIVE NODES]
${activeNodes.length} NODES REPORTING — ${safeNodes.length} SAFE, ${dangerNodes.length} DANGER, ${resourceNodes.length} RESOURCE

[STATUS]
OPERATING IN BLACKOUT MODE
FULL SYNTHESIS AVAILABLE WHEN UPLINK RESTORED
─────────────────────────────`;

    setIntelSource("LOCAL_AI");
    setIntelText("");
    for (const char of brief) {
      setIntelText(prev => prev + char);
      await new Promise(r => setTimeout(r, 8));
    }
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     TIER 1 — Groq cloud AI
     ═══════════════════════════════════════════════════════════════ */
  const parseWithGroq = useCallback(async (msg) => {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${import.meta.env.VITE_GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          max_tokens: 150,
          messages: [
            {
              role: "system",
              content: `You are a crisis packet parser. Extract structured data from survival messages in ANY language.
Respond ONLY with a JSON object, no markdown:
{"type":"danger|resource|safe","needs":["water","food","medical","shelter"],"severity":"critical|high|medium|low","summary":"max 8 words in English","language":"detected language name"}`,
            },
            { role: "user", content: msg },
          ],
        }),
      });
      const data   = await response.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      return { ...parsed, source: "CLOUD_AI" };
    } catch (e) {
      return null;
    }
  }, []);

  const synthesizeWithGroq = useCallback(async (nodes) => {
    const activeNodes = Object.values(nodes).filter(n => n && n.message);
    if (!activeNodes.length) return false;

    const nodeReports = activeNodes
      .map(n => `NODE ${n.id} [${n.type?.toUpperCase()}] ${n.locationReal ? "GPS" : "EST"}: "${n.message}"`)
      .join("\n");

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${import.meta.env.VITE_GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          max_tokens: 350,
          stream: true,
          messages: [
            {
              role: "system",
              content: `You are GhostNet's crisis AI. Analyze mesh survival reports and produce a tactical intelligence brief.
CRITICAL FORMATTING RULE: You MUST output a blank line after every section header before writing content. Plain text only, absolutely no markdown.

Format EXACTLY like this — blank lines are mandatory:

─────────────────────────────
GHOSTNET INTEL BRIEF ${nowZ()}
◈ CLOUD AI — FULL ANALYSIS
─────────────────────────────

[THREAT ASSESSMENT]

Your threat assessment text here. One line max.

[RESOURCES]

Your resources text here. One line max.

[RECOMMENDATION]

One specific actionable recommendation.

[ANOMALIES]

NONE DETECTED or describe anomaly.

─────────────────────────────

Under 120 words total. Be direct. Lives depend on this.`,
            },
            {
              role: "user",
              content: `Mesh reports:\n${nodeReports}\n\nGenerate brief now.`,
            },
          ],
        }),
      });

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      setIntelSource("CLOUD_AI");
      setIntelText("");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk
          .split("\n")
          .filter(l => l.startsWith("data: ") && l !== "data: [DONE]");
        for (const line of lines) {
          try {
            const json  = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) setIntelText(prev => prev + delta);
          } catch (_) {}
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     TIER SWITCHING
     ═══════════════════════════════════════════════════════════════ */
  const hasGroqKey = !!import.meta.env.VITE_GROQ_API_KEY;

  const parseMessage = useCallback(async (msg) => {
    if (blackout || !hasGroqKey) {
      const local = await parseWithLocalAI(msg);
      return local || { type: classifyMessageFallback(msg), needs: detectNeedsFallback(msg), source: "FALLBACK" };
    }
    const cloud = await parseWithGroq(msg);
    if (cloud) return cloud;
    const local = await parseWithLocalAI(msg);
    return local || { type: classifyMessageFallback(msg), needs: detectNeedsFallback(msg), source: "FALLBACK" };
  }, [blackout, hasGroqKey, parseWithGroq, parseWithLocalAI]);

  const synthesizeIntel = useCallback(async (nodes) => {
    const activeNodes = Object.values(nodes).filter(n => n && n.message);
    if (!activeNodes.length) return;
    setIsSynthesizing(true);
    try {
      if (blackout || !hasGroqKey) {
        await generateLocalIntel(nodes);
      } else {
        const ok = await synthesizeWithGroq(nodes);
        if (!ok) await generateLocalIntel(nodes);
      }
    } finally {
      setIsSynthesizing(false);
    }
  }, [blackout, hasGroqKey, synthesizeWithGroq, generateLocalIntel]);

  /* ═══════════════════════════════════════════════════════════════
     CRYPTO — ECDSA P-256 packet signing & verification
     ═══════════════════════════════════════════════════════════════ */
  const signPacket = useCallback(async (packetBuffer) => {
    if (!cryptoKeysRef.current) return null;
    try {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKeysRef.current.privateKey,
        packetBuffer
      );
      return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
    } catch (e) {
      return null;
    }
  }, []);

  const verifyPacket = useCallback(async (packetBuffer, signatureHex, senderPublicKeyJwk) => {
    try {
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        JSON.parse(senderPublicKeyJwk),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      const signatureBytes = new Uint8Array(
        signatureHex.match(/.{2}/g).map(b => parseInt(b, 16))
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signatureBytes,
        packetBuffer
      );
    } catch (e) {
      return false;
    }
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     FAMILY TRACE — privacy-preserving phone number search
     ═══════════════════════════════════════════════════════════════ */
  const hashPhone = useCallback(async (phone) => {
    const cleaned = phone.replace(/\D/g, "");
    if (!cleaned) return null;
    const buffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(cleaned)
    );
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  }, []);

  const handleFamilyTrace = useCallback(async () => {
    const validInputs = familyInputs.filter(s => s.trim().length > 4);
    if (!validInputs.length) return;
    setTracing(true);

    // Build watchlist: hash -> display string
    const newWatchlist = new Map();
    for (const phone of validInputs) {
      const h = await hashPhone(phone.trim());
      if (h) newWatchlist.set(h, phone.trim());
    }
    familyWatchlistRef.current = newWatchlist;

    // Scan current mesh
    const matches = {};
    for (const node of Object.values(networkNodes)) {
      if (!node || !node.familyHashes) continue;
      for (const h of node.familyHashes) {
        if (newWatchlist.has(h)) {
          matches[h] = {
            node,
            input:    newWatchlist.get(h),
            ts:       node.timestamp,
          };
        }
      }
    }
    setFamilyMatches(matches);
    setTracing(false);
  }, [familyInputs, networkNodes, hashPhone]);

  /* ═══════════════════════════════════════════════════════════════
     YJS + GEOLOCATION BOOTSTRAP
     ═══════════════════════════════════════════════════════════════ */
  useEffect(() => {
    loadLocalAI();

    const ydoc    = ydocRef.current;
    const provider = new WebrtcProvider("ghostnet-crisis-mesh-v1", ydoc, {
      signaling: [
        "wss://signaling.yjs.dev",
        "wss://y-webrtc-signaling-eu.herokuapp.com",
      ],
    });
    providerRef.current = provider;

    const persistence = new IndexeddbPersistence("ghostnet", ydoc);
    const nodesMap    = ydoc.getMap("nodes");
    nodesMapRef.current = nodesMap;

    /* ── Generate ECDSA key pair ── */
    const generateKeys = async () => {
      try {
        const keyPair = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"]
        );
        const publicKeyExported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
        cryptoKeysRef.current = keyPair;
        setCryptoKeys(keyPair);
        setSecurityStatus("SECURED");

        // Publish our public key into the mesh so peers can verify our packets
        const current = nodesMap.get(nodeId) || {};
        nodesMap.set(nodeId, {
          ...current,
          publicKey: JSON.stringify(publicKeyExported),
        });
      } catch (e) {
        console.warn("Crypto key generation failed:", e);
        setSecurityStatus("UNSECURED");
      }
    };
    generateKeys();

    persistence.whenSynced.then(() => {
      setSyncStatus("SYNCED");
      nodesMap.set(nodeId, {
        id:           nodeId,
        lat:          20.5937 + (Math.random() - 0.5) * 20,
        lng:          78.9629 + (Math.random() - 0.5) * 20,
        status:       "SAFE",
        message:      "",
        type:         "safe",
        needs:        [],
        locationReal: false,
        accuracy:     null,
        timestamp:    Date.now(),
      });

      /* Geolocation */
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            const current = nodesMap.get(nodeId) || {};
            nodesMap.set(nodeId, { ...current, lat: latitude, lng: longitude, accuracy: Math.round(accuracy), locationReal: true });
            setUserLocation([latitude, longitude]);
            setGpsAccuracy(Math.round(accuracy));
            setGpsStatus("CONFIRMED");
          },
          () => { setGpsStatus("ESTIMATED"); },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      } else {
        setGpsStatus("ESTIMATED");
      }
    });

    /* Observe shared map — verify signatures with retry + auto-synthesize on new messages */
    const verifyWithRetry = async (value, key, allNodes) => {
      if (!value.signature || !value.publicKey) {
        allNodes[key] = { ...value, verified: false, verifyStatus: "NO_KEY" };
        return;
      }
      const packetBuffer = SurvivalPacket.encode(
        value.id || key, value.lat ?? 0, value.lng ?? 0, "ACTIVE", value.type ?? "safe", []
      );
      let valid = await verifyPacket(packetBuffer, value.signature, value.publicKey);
      if (!valid) {
        // Public key may not have propagated yet — retry once after 2 s
        await new Promise(r => setTimeout(r, 2000));
        valid = await verifyPacket(packetBuffer, value.signature, value.publicKey);
      }
      allNodes[key] = { ...value, verified: valid, verifyStatus: valid ? "VERIFIED" : "FAILED" };
      if (!valid) console.warn(`⚠ GHOSTNET: Rejected unverified packet from ${value.id}`);
    };

    const onMapChange = () => {
      const allNodes  = {};
      const promises  = [];

      nodesMap.forEach((value, key) => {
        if (!value) return;

        if (value.id === nodeId) {
          allNodes[key] = { ...value, verified: true, verifyStatus: "SELF" };
          return;
        }

        promises.push(verifyWithRetry(value, key, allNodes));
      });

      Promise.all(promises).then(() => {
        const snapshot = { ...allNodes };
        setNetworkNodes(snapshot);

        // Family trace: check incoming nodes' hashes against watchlist
        if (familyWatchlistRef.current.size > 0) {
          const newMatches = {};
          for (const node of Object.values(snapshot)) {
            if (!node || !node.familyHashes) continue;
            for (const h of node.familyHashes) {
              if (familyWatchlistRef.current.has(h)) {
                newMatches[h] = {
                  node,
                  input: familyWatchlistRef.current.get(h),
                  ts:    node.timestamp,
                };
              }
            }
          }
          if (Object.keys(newMatches).length > 0) {
            setFamilyMatches(prev => ({ ...prev, ...newMatches }));
          }
        }

        const msgCount = Object.values(snapshot).filter(n => n && n.message).length;
        if (msgCount > prevMsgCount.current) {
          prevMsgCount.current = msgCount;
          setTimeout(() => synthesizeIntel(snapshot), 300);
        }
      });
    };
    nodesMap.observe(onMapChange);

    /* Awareness */
    const onAwareness = () => setPeerCount(provider.awareness.getStates().size);
    provider.awareness.on("change", onAwareness);
    provider.awareness.setLocalState({ nodeId, joined: Date.now() });

    return () => {
      nodesMap.unobserve(onMapChange);
      provider.awareness.off("change", onAwareness);
      try { nodesMap.set(nodeId, undefined); } catch (_) {}
      provider.destroy();
      persistence.destroy();
    };
    // synthesizeIntel excluded intentionally — we use a ref snapshot pattern above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, loadLocalAI]);

  /* Keep cryptoKeysRef in sync for observer closures */
  useEffect(() => { cryptoKeysRef.current = cryptoKeys; }, [cryptoKeys]);

  /* Re-synthesize when blackout toggles (tier changes) */
  useEffect(() => {
    blackoutRef.current = blackout;
    const activeNodes = Object.values(networkNodes).filter(n => n && n.message);
    if (activeNodes.length > 0) synthesizeIntel(networkNodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blackout]);

  /* ── Blackout toggle — real WebRTC disconnect/reconnect + packet queue flush ── */
  const toggleBlackout = useCallback(async () => {
    if (!blackout) {
      /* ── ENTERING BLACKOUT ── */
      // 1. Flicker the UI
      document.body.classList.add("flickering");
      await new Promise(r => setTimeout(r, 400));
      document.body.classList.remove("flickering");

      // 2. Actually disconnect WebRTC
      if (providerRef.current) providerRef.current.disconnect();

      // 3. Update state + banner
      blackoutRef.current = true;
      setBlackout(true);
      setBlackoutBanner("blackout");

      // 4. Switch Intel Feed to local AI
      await generateLocalIntel(networkNodes);

    } else {
      /* ── EXITING BLACKOUT — UPLINK RESTORED ── */
      setBlackoutBanner("restored");
      setSyncingPackets(true);

      // 1. Reconnect WebRTC
      if (providerRef.current) providerRef.current.connect();

      // 2. Flush queued packets into mesh with staggered delay
      setQueuedPackets(prev => {
        const toFlush = [...prev];
        (async () => {
          for (const packet of toFlush) {
            if (nodesMapRef.current) {
              nodesMapRef.current.set(
                packet.nodeId + "_queued_" + packet.timestamp,
                { ...packet, synced: true }
              );
              await new Promise(r => setTimeout(r, 200));
            }
          }
          setSyncingPackets(false);
        })();
        return []; // clear queue immediately in state
      });

      blackoutRef.current = false;
      setBlackout(false);

      // 3. Switch back to cloud AI after connection settles
      await new Promise(r => setTimeout(r, 1500));
      await synthesizeWithGroq(networkNodes);

      // 4. Clear restored banner after 3 seconds
      await new Promise(r => setTimeout(r, 3000));
      setBlackoutBanner(null);
    }
  }, [blackout, networkNodes, generateLocalIntel, synthesizeWithGroq]);

  /* ── BROADCAST PACKET ── */
  const handleBroadcast = useCallback(async () => {
    const text = message.trim();
    if (!text || !nodesMapRef.current) return;

    const quickType  = classifyMessageFallback(text);
    const quickNeeds = detectNeedsFallback(text);
    const time       = nowZ();

    const current = nodesMapRef.current.get(nodeId) || {};
    const lat = current.lat ?? 20.5937;
    const lng = current.lng ?? 78.9629;

    // Encode binary packet
    const buffer    = SurvivalPacket.encode(nodeId, lat, lng, "ACTIVE", quickType, quickNeeds);
    const hexString = SurvivalPacket.toHexString(buffer);
    const hexTrunc  = hexString.slice(0, 35) + "...";

    // Sign the packet with this node's private key
    const signature = await signPacket(buffer);

    // Base node update payload (shared between blackout/online paths)
    const selfHashes = Array.from(familyWatchlistRef.current.keys());
    const nodeUpdate = {
      ...current,
      message:      text,
      type:         quickType,
      needs:        quickNeeds,
      timestamp:    Date.now(),
      signature:    signature || null,
      familyHashes: selfHashes.length ? selfHashes : (current.familyHashes || []),
    };

    if (blackout) {
      /* ── BLACKOUT: queue locally, do NOT write to shared Yjs map ── */
      const queueEntry = {
        nodeId,
        lat, lng,
        message:   text,
        type:      quickType,
        needs:     quickNeeds,
        signature: signature || null,
        timestamp: Date.now(),
      };
      setQueuedPackets(prev => [...prev, queueEntry]);

      // Local-only preview — will NOT propagate until uplink restored
      nodesMapRef.current.set(nodeId, { ...nodeUpdate, localOnly: true });

      setPacketLog(prev => [
        {
          id: Date.now(), time, direction: "TX", hex: hexTrunc,
          status: "QUEUED", type: quickType, queued: true,
          signed: !!signature,
        },
        ...prev.slice(0, 49),
      ]);
    } else {
      /* ── ONLINE: write signed update to shared Yjs map ── */
      nodesMapRef.current.set(nodeId, { ...nodeUpdate, localOnly: false });

      setPacketLog(prev => [
        {
          id: Date.now(), time, direction: "TX", hex: hexTrunc,
          status: signature ? "SIGNED" : "BROADCAST", type: quickType, queued: false,
          signed: !!signature,
        },
        ...prev.slice(0, 49),
      ]);
    }

    setMessage("");

    // Async AI enrichment — upgrade classification after the fact
    const aiResult = await parseMessage(text);
    if (aiResult && nodesMapRef.current) {
      const latest = nodesMapRef.current.get(nodeId) || {};
      nodesMapRef.current.set(nodeId, {
        ...latest,
        type:     aiResult.type     || quickType,
        needs:    aiResult.needs    || quickNeeds,
        language: aiResult.language || null,
        severity: aiResult.severity || null,
        summary:  aiResult.summary  || null,
        aiSource: aiResult.source   || null,
      });
    }
  }, [message, nodeId, blackout, signPacket, parseMessage]);

  /* ── Derived ── */
  const meshFilled   = blackout ? 1 : Math.min(peerCount, 5);
  const remotePeers  = Object.values(networkNodes).filter(n => n && n.id !== nodeId);
  const queuedCount  = queuedPackets.length;

  /* AI tier label */
  let aiLabel, aiColor;
  if (localAILoading) {
    aiLabel = "◈ AI LOADING..."; aiColor = "var(--muted)";
  } else if (blackout && localAIReady) {
    aiLabel = "◈ LOCAL AI";      aiColor = "var(--orange)";
  } else if (blackout && !localAIReady) {
    aiLabel = "◈ AI OFFLINE";    aiColor = "var(--red)";
  } else if (!blackout && hasGroqKey) {
    aiLabel = "◈ CLOUD AI";      aiColor = "var(--cyan)";
  } else if (localAIReady) {
    aiLabel = "◈ LOCAL AI";      aiColor = "var(--orange)";
  } else {
    aiLabel = "◈ AI OFFLINE";    aiColor = "var(--red)";
  }

  const intelHeaderLabel = intelSource === "CLOUD_AI"
    ? "◈ INTEL FEED — CLOUD SYNTHESIS"
    : intelSource === "LOCAL_AI"
      ? "◈ INTEL FEED — LOCAL AI ACTIVE"
      : "◈ INTEL FEED";
  const intelHeaderColor = intelSource === "CLOUD_AI" ? "var(--cyan)"
    : intelSource === "LOCAL_AI" ? "var(--orange)"
    : "var(--muted)";

  /* ── Render ── */
  return (
    <div className={`app-shell dot-grid${blackout ? " blackout-active" : ""}`}>

      {/* ── TOP BAR ── */}
      <header className="topbar">
        <div className="topbar-left">
          <span className="topbar-brand font-space">◈ GHOSTNET</span>
          <span className="topbar-version">v1.0</span>
          <span className="topbar-sep">|</span>
          <span className="topbar-protocol font-space">Crisis Mesh Protocol</span>
        </div>

        <MeshDots filled={meshFilled} />

        <div className="topbar-right" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* AI tier badge */}
          <span style={{
            fontFamily: "'Space Mono',monospace",
            fontSize: 9,
            letterSpacing: "0.1em",
            color: aiColor,
            animation: localAILoading ? "blink-cursor 1s step-end infinite" : "none",
          }}>
            {aiLabel}
          </span>

          {/* Sync badge */}
          <span style={{
            fontFamily: "'Space Mono',monospace",
            fontSize: 9,
            letterSpacing: "0.1em",
            color: syncStatus === "SYNCED" ? "var(--green)" : "var(--orange)",
          }}>
            {syncStatus === "SYNCED" ? "● SYNCED" : "◌ SYNCING"}
          </span>

          {/* AID VIEW link */}
          <a
            href="/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color:          "#00D4FF",
              fontFamily:     "'Space Mono',monospace",
              fontSize:       10,
              letterSpacing:  "0.08em",
              border:         "1px solid rgba(0,212,255,0.5)",
              padding:        "3px 8px",
              textDecoration: "none",
              borderRadius:   2,
              transition:     "all 0.15s",
            }}
            onMouseEnter={e => e.target.style.background = "rgba(0,212,255,0.08)"}
            onMouseLeave={e => e.target.style.background = "transparent"}
          >
            ◈ AID VIEW
          </a>

          <button
            className={`blackout-toggle font-space${blackout ? " active" : ""}`}
            onClick={toggleBlackout}
            aria-label="Toggle blackout mode"
          >
            {blackout
              ? "⚠ BLACKOUT ACTIVE"
              : syncingPackets
                ? "↑ SYNCING..."
                : "● UPLINK ACTIVE"}
          </button>
        </div>
      </header>

      {/* ── BANNERS ── */}
      {blackoutBanner === "blackout" && (
        <div className="blackout-banner">
          ⚠ NETWORK BLACKOUT ACTIVE — MESH DISCONNECTED — LOCAL AI ENGAGED — {queuedCount} PACKETS QUEUED
        </div>
      )}
      {blackoutBanner === "restored" && (
        <div className="restored-banner">
          {syncingPackets
            ? `✓ UPLINK RESTORED — SYNCHRONIZING ${queuedCount} QUEUED PACKETS TO MESH...`
            : "✓ UPLINK RESTORED — MESH SYNCHRONIZED — CLOUD AI RESUMING"}
        </div>
      )}

      {/* ── MAIN LAYOUT ── */}
      <div className="main-layout">

        {/* ── LEFT PANEL ── */}
        <aside className="panel panel-left dot-grid">

          {/* NODE TERMINAL */}
          <div className="panel-section">
            <span className="section-label">◈ Node Terminal</span>
            <div className="node-row">
              <span className="node-key">Node ID</span>
              <span className="node-val">{nodeId}</span>
            </div>
            <div className="node-row">
              <span className="node-key">Status</span>
              <span className="node-val safe">SAFE</span>
            </div>
            <div className="node-row">
              <span className="node-key">Peers</span>
              <span className="node-val" style={{ color: "var(--cyan)" }}>{peerCount} ONLINE</span>
            </div>
            <div className="node-row">
              <span className="node-key">Protocol</span>
              <span className="node-val" style={{ color: "var(--cyan)", fontSize: "10px" }}>MESH-V2</span>
            </div>
            <div className="node-row">
              <span className="node-key">Security</span>
              <span style={{
                fontFamily: "'Space Mono',monospace",
                fontSize: 9,
                letterSpacing: "0.08em",
                color: securityStatus === "SECURED"
                  ? "var(--green)"
                  : securityStatus === "GENERATING"
                    ? "var(--muted)"
                    : "var(--orange)",
                textShadow: securityStatus === "SECURED"
                  ? "0 0 6px rgba(0,255,148,0.3)"
                  : "none",
                animation: securityStatus === "GENERATING"
                  ? "blink-cursor 1s step-end infinite"
                  : "none",
              }}>
                {securityStatus === "SECURED"
                  ? "◈ ECDSA P-256"
                  : securityStatus === "GENERATING"
                    ? "◈ GENERATING..."
                    : "⚠ UNSECURED"}
              </span>
            </div>
            <div className="node-row" style={{ marginTop: 4 }}>
              <span className="node-key">Location</span>
              {gpsStatus === "PENDING"    && <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.08em", color: "var(--muted)" }}>◌ ACQUIRING...</span>}
              {gpsStatus === "CONFIRMED"  && <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.08em", color: "var(--green)", textShadow: "0 0 6px rgba(0,255,148,0.3)" }}>GPS ± {gpsAccuracy}m</span>}
              {gpsStatus === "ESTIMATED"  && <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.08em", color: "var(--orange)" }}>ESTIMATED</span>}
            </div>
            <div style={{
              marginTop: 6,
              padding: "4px 8px",
              background: gpsStatus === "CONFIRMED" ? "rgba(0,255,148,0.05)" : "rgba(255,107,53,0.05)",
              border: `1px solid ${gpsStatus === "CONFIRMED" ? "rgba(0,255,148,0.12)" : "rgba(255,107,53,0.12)"}`,
              borderRadius: 2,
            }}>
              <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, letterSpacing: "0.1em", color: gpsStatus === "CONFIRMED" ? "var(--green)" : "var(--orange)" }}>
                {gpsStatus === "CONFIRMED" ? "◈ LOCATION: GPS CONFIRMED" : gpsStatus === "ESTIMATED" ? "◈ LOCATION: ESTIMATED" : "◈ LOCATION: ACQUIRING GPS"}
              </span>
            </div>
          </div>

          <div className="divider" />

          {/* BROADCAST */}
          <div className="panel-section">
            <span className="section-label">◈ Broadcast</span>
            <textarea
              className="broadcast-area"
              rows={3}
              placeholder="Enter survival report... (any language)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleBroadcast(); }}
            />
            <button className="broadcast-btn" onClick={handleBroadcast}>
              [ BROADCAST PACKET ]
            </button>
          </div>

          <div className="divider" />

          {/* ACTIVE PEERS */}
          <div className="panel-section" style={{ paddingBottom: 14 }}>
            <span className="section-label">◈ Active Peers</span>

            {/* Queued packet indicator during blackout */}
            {blackout && queuedCount > 0 && (
              <div style={{
                marginBottom: 8,
                padding: "5px 8px",
                background: "rgba(255,107,53,0.08)",
                border: "1px solid rgba(255,107,53,0.3)",
                borderRadius: 2,
                fontFamily: "'Space Mono',monospace",
                fontSize: 9,
                letterSpacing: "0.1em",
                color: "var(--orange)",
                animation: "pulse-red 2s infinite",
              }}>
                ◈ {queuedCount} PACKET{queuedCount > 1 ? "S" : ""} QUEUED
              </div>
            )}
            <div className="peer-list">
              {remotePeers.length === 0 ? (
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)", padding: "6px 0" }}>
                  ◌ AWAITING PEERS...
                </div>
              ) : (
                remotePeers.map((peer) => {
                  const color = nodeColor(peer.type);
                  return (
                    <div className="peer-item" key={peer.id}>
                      <span className="peer-dot" style={{ color }}>●</span>
                      <span className="peer-id"  style={{ color }}>{peer.id}</span>
                      <span className="peer-status online">● ONLINE</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="divider" />

          {/* ── FAMILY TRACE ── */}
          <div className="panel-section" style={{ paddingBottom: 14 }}>
            <span className="section-label">◈ Family Trace</span>
            <div style={{
              fontFamily: "'Space Mono',monospace",
              fontSize: 8,
              letterSpacing: "0.08em",
              color: "var(--muted)",
              marginBottom: 8,
              lineHeight: 1.6,
            }}>
              Enter phone numbers to locate family in mesh. Hashed locally — no raw numbers transmitted.
            </div>

            {/* Input list */}
            {familyInputs.map((val, i) => (
              <div key={i} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                <input
                  type="text"
                  value={val}
                  onChange={e => {
                    const next = [...familyInputs];
                    next[i] = e.target.value;
                    setFamilyInputs(next);
                  }}
                  placeholder="+91 98765 43210"
                  style={{
                    flex:        1,
                    background:  "rgba(255,255,255,0.03)",
                    border:      "1px solid var(--border)",
                    color:       "var(--text)",
                    fontFamily:  "'JetBrains Mono',monospace",
                    fontSize:    10,
                    padding:     "5px 8px",
                    borderRadius: 2,
                    outline:     "none",
                  }}
                  onFocus={e => e.target.style.borderColor = "rgba(0,212,255,0.4)"}
                  onBlur={e  => e.target.style.borderColor = "var(--border)"}
                />
                {familyInputs.length > 1 && (
                  <button
                    onClick={() => setFamilyInputs(prev => prev.filter((_, j) => j !== i))}
                    style={{
                      background: "transparent", border: "1px solid var(--border)",
                      color: "var(--muted)", fontFamily: "'Space Mono',monospace",
                      fontSize: 9, padding: "0 6px", cursor: "pointer", borderRadius: 2,
                    }}
                  >✕</button>
                )}
              </div>
            ))}

            {/* Add + Trace buttons */}
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <button
                onClick={() => setFamilyInputs(prev => [...prev, ""])}
                style={{
                  flex: 1, background: "transparent",
                  border: "1px solid var(--border)", color: "var(--muted)",
                  fontFamily: "'Space Mono',monospace", fontSize: 9,
                  padding: "5px 0", cursor: "pointer", borderRadius: 2,
                  letterSpacing: "0.06em",
                }}
              >
                + ADD
              </button>
              <button
                onClick={handleFamilyTrace}
                disabled={tracing}
                style={{
                  flex: 2, background: "transparent",
                  border: `1px solid ${tracing ? "var(--muted)" : "rgba(0,212,255,0.5)"}`,
                  color: tracing ? "var(--muted)" : "var(--cyan)",
                  fontFamily: "'Space Mono',monospace", fontSize: 9, fontWeight: 700,
                  padding: "5px 0", cursor: tracing ? "not-allowed" : "pointer",
                  borderRadius: 2, letterSpacing: "0.08em",
                }}
              >
                {tracing ? "[ TRACING... ]" : "[ TRACE ]"}
              </button>
            </div>

            {/* Results */}
            {familyInputs.some(v => v.trim().length > 4) && (
              <div style={{ marginTop: 10 }}>
                {familyInputs.filter(v => v.trim().length > 4).map((phone, i) => {
                  // Find match for this phone (look up by iterating matches)
                  const matchEntry = Object.values(familyMatches).find(m => m.input === phone.trim());
                  return (
                    <div key={i} style={{
                      marginBottom: 8,
                      padding: "7px 8px",
                      background: matchEntry ? "rgba(0,255,148,0.04)" : "rgba(74,74,106,0.06)",
                      border: `1px solid ${matchEntry ? "rgba(0,255,148,0.15)" : "rgba(74,74,106,0.2)"}`,
                      borderRadius: 2,
                    }}>
                      <div style={{
                        fontFamily: "'Space Mono',monospace", fontSize: 9,
                        letterSpacing: "0.06em",
                        color: matchEntry ? "var(--green)" : "var(--muted)",
                        marginBottom: matchEntry ? 4 : 0,
                      }}>
                        ◈ {phone.trim()}
                      </div>
                      {matchEntry ? (
                        <>
                          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--green)" }}>
                            ● LAST SEEN: NODE {matchEntry.node.id} — {new Date(matchEntry.ts).toISOString().slice(11, 16)}Z
                          </div>
                          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "var(--muted)", marginTop: 2 }}>
                            {matchEntry.node.locationReal
                              ? `GPS CONFIRMED ±${matchEntry.node.accuracy}m`
                              : "GPS ESTIMATED"}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--muted)" }}>
                          ○ NOT YET DETECTED IN MESH
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </aside>

        {/* ── CENTER — live P2P map ── */}
        <main className="panel panel-center">
          <div id="map" className={blackout ? "blackout-map" : ""}>
            <GhostMap networkNodes={networkNodes} nodeId={nodeId} userLocation={userLocation} />
          </div>
        </main>

        {/* ── RIGHT PANEL ── */}
        <aside className="panel panel-right dot-grid">

          {/* INTEL FEED */}
          <div className="panel-section intel-feed-wrap" style={{ paddingTop: 14, flex: 1, minHeight: 0 }}>

            {/* Dynamic header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span className="section-label" style={{ margin: 0, color: intelHeaderColor, borderBottomColor: `${intelHeaderColor}1A` }}>
                {intelHeaderLabel}
              </span>
              {isSynthesizing && (
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "var(--muted)", animation: "blink-cursor 0.8s step-end infinite" }}>
                  PROCESSING...
                </span>
              )}
            </div>

            <div className="intel-feed">
              {!intelText ? (
                <p className="intel-placeholder">
                  AWAITING INCOMING PACKETS — INTELLIGENCE SYNTHESIS WILL APPEAR HERE
                </p>
              ) : (
                <IntelTextRenderer text={intelText} />
              )}
            </div>

            {/* Refresh Intel button */}
            <button
              onClick={() => synthesizeIntel(networkNodes)}
              disabled={isSynthesizing}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "6px 0",
                background: "transparent",
                border: `1px solid ${isSynthesizing ? "var(--muted)" : "rgba(0,212,255,0.4)"}`,
                color: isSynthesizing ? "var(--muted)" : "var(--cyan)",
                fontFamily: "'Space Mono',monospace",
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.1em",
                cursor: isSynthesizing ? "not-allowed" : "pointer",
                borderRadius: 2,
                transition: "all 0.15s ease",
              }}
              onMouseEnter={e => { if (!isSynthesizing) e.target.style.background = "rgba(0,212,255,0.06)"; }}
              onMouseLeave={e => { e.target.style.background = "transparent"; }}
            >
              {isSynthesizing ? "[ SYNTHESIZING... ]" : "[ REFRESH INTEL ]"}
            </button>
          </div>

          <div className="divider" style={{ margin: "10px 14px" }} />

          {/* PACKET LOG */}
          <div className="panel-section packet-log-wrap" style={{ paddingTop: 0, flex: 1, minHeight: 0 }}>
            <span className="section-label" style={{ margin: "0 14px 8px", display: "block" }}>
              ◈ Packet Log
            </span>
            <div className="packet-log">
              {packetLog.length === 0 ? (
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)", padding: "4px 0" }}>
                  [ NO TRANSMISSIONS YET ]
                </div>
              ) : (
                packetLog.map((l) => <LogEntry key={l.id} {...l} />)
              )}
            </div>
          </div>

        </aside>
      </div>
    </div>
  );
}
