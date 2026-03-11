import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon   from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { IndexeddbPersistence } from "y-indexeddb";

/* ── Leaflet icon fix ───────────────────────────────────────────────── */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */
const nowZ    = () => new Date().toISOString().slice(11, 19) + "Z";
const nowFull = () => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";

const nodeColor = (type) => {
  if (type === "danger")   return "#FF2D55";
  if (type === "resource") return "#00D4FF";
  return "#00FF94";
};

const needIcon = (need) => {
  if (!need) return "◈";
  const n = need.toLowerCase();
  if (n.includes("water"))   return "💧";
  if (n.includes("food"))    return "🍞";
  if (n.includes("medical")) return "🏥";
  if (n.includes("shelter")) return "🏠";
  return "◈";
};

const inferRegion = (nodes) => {
  const withGPS = Object.values(nodes).filter(n => n && n.locationReal && n.lat != null);
  if (!withGPS.length) return "REGION UNKNOWN — GPS DATA INSUFFICIENT";
  const avgLat = withGPS.reduce((s, n) => s + n.lat, 0) / withGPS.length;
  const avgLng = withGPS.reduce((s, n) => s + n.lng, 0) / withGPS.length;
  // Very rough region inference
  if (avgLat > 60)  return "NORTHERN EUROPE / ARCTIC REGION";
  if (avgLat > 35 && avgLng > 60 && avgLng < 100) return "CENTRAL ASIA";
  if (avgLat > 20 && avgLat < 40 && avgLng > 60 && avgLng < 80) return "NORTHERN INDIA / PAKISTAN";
  if (avgLat > 5  && avgLat < 25 && avgLng > 68 && avgLng < 90) return "INDIAN SUBCONTINENT";
  if (avgLat > -5 && avgLat < 20 && avgLng > 30 && avgLng < 55) return "EAST AFRICA / HORN OF AFRICA";
  if (avgLat > 15 && avgLat < 35 && avgLng > 30 && avgLng < 60) return "MIDDLE EAST";
  if (avgLat > -15 && avgLat < 15 && avgLng > 95 && avgLng < 130) return "SOUTHEAST ASIA";
  return `LAT ${avgLat.toFixed(2)} / LNG ${avgLng.toFixed(2)}`;
};

const severityFromNode = (node) => {
  if (!node.message) return null;
  const t = node.message.toLowerCase();
  if (/explosion|bomb|blast|attack|armed|hostile|shot/.test(t)) return "CRITICAL";
  if (/danger|fire|threat|flood|collapse/.test(t))               return "HIGH";
  if (/injured|hurt|medical|help/.test(t))                       return "MEDIUM";
  return "LOW";
};

const severityColor = (sev) => {
  if (sev === "CRITICAL") return "#FF2D55";
  if (sev === "HIGH")     return "#FF6B35";
  if (sev === "MEDIUM")   return "#FFD60A";
  return "#00FF94";
};

/* ═══════════════════════════════════════════════════════════════════
   MAP HELPERS
   ═══════════════════════════════════════════════════════════════════ */
function MapInvalidator() {
  const map = useMap();
  useEffect(() => { setTimeout(() => map.invalidateSize(), 150); }, [map]);
  return null;
}

function MapFitter({ nodes }) {
  const map    = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    const valid = Object.values(nodes).filter(n => n && n.lat != null && n.lng != null);
    if (valid.length >= 2) {
      const bounds = valid.map(n => [n.lat, n.lng]);
      map.fitBounds(bounds, { padding: [40, 40] });
      fitted.current = true;
    }
  }, [nodes, map]);
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   STAT CARD
   ═══════════════════════════════════════════════════════════════════ */
function StatCard({ label, value, color, sublabel }) {
  return (
    <div style={{
      flex: 1,
      background: "var(--surface)",
      border: `1px solid ${color}33`,
      borderTop: `2px solid ${color}`,
      borderRadius: 3,
      padding: "12px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.025) 1px, transparent 1px)",
        backgroundSize: "14px 14px",
        pointerEvents: "none",
      }} />
      <div style={{
        fontFamily: "'Space Mono',monospace",
        fontSize: 28,
        fontWeight: 700,
        color,
        textShadow: `0 0 20px ${color}55`,
        lineHeight: 1,
      }}>
        {value}
      </div>
      <div style={{
        fontFamily: "'Space Mono',monospace",
        fontSize: 9,
        letterSpacing: "0.14em",
        color: "var(--muted)",
        textTransform: "uppercase",
      }}>
        {label}
      </div>
      {sublabel && (
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: `${color}88` }}>
          {sublabel}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SITUATION REPORT MODAL
   ═══════════════════════════════════════════════════════════════════ */
function SituationReportModal({ nodes, onClose }) {
  const [reportText, setReportText] = useState("");
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    const generate = async () => {
      const activeNodes = Object.values(nodes).filter(n => n && n.message);
      const region      = inferRegion(nodes);

      if (!import.meta.env.VITE_GROQ_API_KEY || !activeNodes.length) {
        // Fallback offline report
        const dangerNodes   = activeNodes.filter(n => n.type === "danger");
        const resourceNodes = activeNodes.filter(n => n.type === "resource");
        const gpsNodes      = activeNodes.filter(n => n.locationReal);
        const report =
`HUMANITARIAN SITUATION REPORT
Generated: ${nowFull()}
Region: ${region}
Source: GHOSTNET MESH NETWORK (LOCAL SYNTHESIS)
─────────────────────────────────────────────────

EXECUTIVE SUMMARY
${activeNodes.length} field nodes are actively reporting via the GhostNet crisis mesh. ${dangerNodes.length > 0 ? `${dangerNodes.length} node${dangerNodes.length > 1 ? "s" : ""} have reported danger situations requiring immediate attention.` : "No immediate danger zones detected."} ${resourceNodes.length > 0 ? `${resourceNodes.length} resource node${resourceNodes.length > 1 ? "s" : ""} are operational.` : "No resource nodes confirmed."}

IMMEDIATE NEEDS
${activeNodes.map(n => `• NODE ${n.id} [${(n.type || "unknown").toUpperCase()}]: ${n.message}`).join("\n")}

RECOMMENDED RESPONSE
${dangerNodes.length > 0
  ? "PRIORITY: Deploy rapid response team to danger zone coordinates. Establish secure communications perimeter."
  : "Maintain monitoring posture. No immediate response required."}

DATA QUALITY
${gpsNodes.length} of ${activeNodes.length} nodes GPS-confirmed
${activeNodes.filter(n => n.verified).length} of ${activeNodes.length} nodes cryptographically verified
Mesh integrity: ${Math.round((activeNodes.filter(n => n.verified).length / Math.max(activeNodes.length, 1)) * 100)}%
─────────────────────────────────────────────────
GENERATED BY GHOSTNET ON-DEVICE SYNTHESIS
CLOUD SYNTHESIS UNAVAILABLE — UPLINK REQUIRED`;

        setLoading(false);
        for (const char of report) {
          setReportText(prev => prev + char);
          await new Promise(r => setTimeout(r, 6));
        }
        return;
      }

      const nodeReports = activeNodes.map(n =>
        `NODE ${n.id} [${(n.type || "?").toUpperCase()}] ${n.locationReal ? `GPS ±${n.accuracy}m` : "ESTIMATED"} [${n.verified ? "VERIFIED" : "UNVERIFIED"}]: "${n.message}"${n.needs?.length ? ` NEEDS: ${n.needs.join(", ")}` : ""}`
      ).join("\n");

      const gpsCount = Object.values(nodes).filter(n => n && n.locationReal).length;
      const allCount = Object.values(nodes).filter(n => n).length;

      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${import.meta.env.VITE_GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model:      "llama-3.3-70b-versatile",
            max_tokens: 600,
            stream:     true,
            messages: [
              {
                role:    "system",
                content: `You are a humanitarian crisis analyst generating formal situation reports for aid organizations (MSF, NDMA, UN OCHA). Be precise, factual, and actionable. Plain text only, no markdown.

Format EXACTLY:
HUMANITARIAN SITUATION REPORT
Generated: ${nowFull()}
Region: ${region}
Source: GHOSTNET MESH NETWORK

─────────────────────────────────────────────────

EXECUTIVE SUMMARY
2-3 sentences maximum.

IMMEDIATE NEEDS
Bullet points, most critical first.

RECOMMENDED RESPONSE
2-3 specific, actionable steps.

DATA QUALITY
${gpsCount} of ${allCount} nodes GPS-confirmed
[verification stats]

─────────────────────────────────────────────────
GENERATED VIA GHOSTNET CLOUD AI`,
              },
              {
                role:    "user",
                content: `Field reports from GhostNet mesh nodes:\n\n${nodeReports}\n\nGenerate situation report now.`,
              },
            ],
          }),
        });

        setLoading(false);
        const reader  = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = decoder.decode(value)
            .split("\n")
            .filter(l => l.startsWith("data: ") && l !== "data: [DONE]");
          for (const line of lines) {
            try {
              const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
              if (delta) setReportText(prev => prev + delta);
            } catch (_) {}
          }
        }
      } catch (e) {
        setLoading(false);
        setReportText("ERROR: Could not reach Groq API. Check VITE_GROQ_API_KEY and network connection.");
      }
    };

    generate();
  }, []); // eslint-disable-line

  return (
    <div style={{
      position: "fixed",
      inset:    0,
      background: "rgba(5,5,8,0.92)",
      zIndex:   9000,
      display:  "flex",
      alignItems: "center",
      justifyContent: "center",
      backdropFilter: "blur(4px)",
    }}>
      <div style={{
        width:     "min(780px, 92vw)",
        maxHeight: "82vh",
        background: "var(--surface)",
        border:    "1px solid var(--border)",
        borderTop: "2px solid var(--green)",
        borderRadius: 4,
        display:   "flex",
        flexDirection: "column",
        boxShadow: "0 0 60px rgba(0,255,148,0.08), 0 0 120px rgba(0,0,0,0.8)",
      }}>
        {/* Modal header */}
        <div style={{
          padding:      "12px 20px",
          borderBottom: "1px solid var(--border)",
          display:      "flex",
          alignItems:   "center",
          justifyContent: "space-between",
          flexShrink:   0,
        }}>
          <span style={{
            fontFamily:    "'Space Mono',monospace",
            fontSize:      11,
            fontWeight:    700,
            letterSpacing: "0.12em",
            color:         "var(--green)",
          }}>
            ◈ HUMANITARIAN SITUATION REPORT
          </span>
          {loading && (
            <span style={{
              fontFamily: "'Space Mono',monospace",
              fontSize:   9,
              color:      "var(--muted)",
              animation:  "dash-blink 0.8s step-end infinite",
            }}>
              GENERATING...
            </span>
          )}
          <button
            onClick={onClose}
            style={{
              background:    "transparent",
              border:        "1px solid var(--border)",
              color:         "var(--muted)",
              fontFamily:    "'Space Mono',monospace",
              fontSize:      10,
              padding:       "4px 10px",
              cursor:        "pointer",
              borderRadius:  2,
              letterSpacing: "0.08em",
            }}
          >
            [ CLOSE ]
          </button>
        </div>

        {/* Report body */}
        <div style={{
          flex:       1,
          overflowY:  "auto",
          padding:    "20px",
          scrollbarWidth: "thin",
          scrollbarColor: "var(--green) var(--surface)",
        }}>
          <pre style={{
            fontFamily:  "'JetBrains Mono',monospace",
            fontSize:    11,
            lineHeight:  1.85,
            color:       "var(--text)",
            whiteSpace:  "pre-wrap",
            wordBreak:   "break-word",
            margin:      0,
          }}>
            {reportText || (loading ? "◌ CONTACTING CLOUD AI..." : "")}
          </pre>
        </div>

        {/* Export button */}
        {!loading && reportText && (
          <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
            <button
              onClick={() => {
                const blob = new Blob([reportText], { type: "text/plain" });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement("a");
                a.href     = url;
                a.download = `ghostnet-sitrep-${nowZ().replace(/:/g, "")}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              style={{
                background:    "transparent",
                border:        "1px solid rgba(0,255,148,0.35)",
                color:         "var(--green)",
                fontFamily:    "'Space Mono',monospace",
                fontSize:      9,
                fontWeight:    700,
                letterSpacing: "0.1em",
                padding:       "7px 16px",
                cursor:        "pointer",
                borderRadius:  2,
              }}
            >
              [ EXPORT REPORT .TXT ]
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   UPLINK BAR — progress meter
   ═══════════════════════════════════════════════════════════════════ */
function UplinkBar({ pct }) {
  const filled = Math.round((pct / 100) * 10);
  return (
    <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--green)", fontSize: 11 }}>
      {"█".repeat(filled)}
      <span style={{ color: "var(--border)" }}>{"░".repeat(10 - filled)}</span>
      <span style={{ color: "var(--muted)", marginLeft: 6 }}>{pct}%</span>
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════════ */
export default function Dashboard() {
  const [nodes,         setNodes]         = useState({});
  const [peerCount,     setPeerCount]     = useState(0);
  const [lastSync,      setLastSync]      = useState(nowZ());
  const [clock,         setClock]         = useState(nowFull());
  const [showReport,    setShowReport]    = useState(false);
  const [reportKey,     setReportKey]     = useState(0);

  const ydocRef    = useRef(null);
  const provRef    = useRef(null);
  const nodesRef   = useRef(null);

  /* ── Clock tick ── */
  useEffect(() => {
    const t = setInterval(() => setClock(nowFull()), 1000);
    return () => clearInterval(t);
  }, []);

  /* ── Connect to same Yjs room ── */
  useEffect(() => {
    const ydoc       = new Y.Doc();
    ydocRef.current  = ydoc;

    const provider   = new WebrtcProvider("ghostnet-crisis-mesh-v1", ydoc, {
      signaling: ["wss://signaling.yjs.dev", "wss://y-webrtc-signaling-eu.herokuapp.com"],
    });
    provRef.current  = provider;

    const persistence = new IndexeddbPersistence("ghostnet", ydoc);
    const nodesMap    = ydoc.getMap("nodes");
    nodesRef.current  = nodesMap;

    // Mark as observer only — don't write any node entry
    provider.awareness.setLocalState({ role: "dashboard", joined: Date.now() });

    const onMapChange = () => {
      const all = {};
      nodesMap.forEach((v, k) => { if (v) all[k] = v; });
      setNodes({ ...all });
      setLastSync(nowZ());
    };
    nodesMap.observe(onMapChange);
    onMapChange(); // hydrate immediately from IndexedDB

    const onAwareness = () => setPeerCount(provider.awareness.getStates().size);
    provider.awareness.on("change", onAwareness);

    return () => {
      nodesMap.unobserve(onMapChange);
      provider.awareness.off("change", onAwareness);
      provider.destroy();
      persistence.destroy();
    };
  }, []);

  /* ── Derived stats ── */
  const allNodes       = Object.values(nodes).filter(n => n && n.id);
  const dangerNodes    = allNodes.filter(n => n.type === "danger");
  const resourceNodes  = allNodes.filter(n => n.type === "resource");
  const criticalNodes  = allNodes.filter(n => severityFromNode(n) === "CRITICAL");
  const gpsNodes       = allNodes.filter(n => n.locationReal);
  const activeMessages = allNodes.filter(n => n.message);

  // Fix 3: precise three-state verification counts
  const verifiedCount   = Object.values(nodes).filter(n => n && n.verified === true).length;
  const unverifiedCount = Object.values(nodes).filter(n => n && n.verified === false).length;
  const pendingCount    = Object.values(nodes).filter(n => n && n.verified === undefined).length;
  const uplinkQuality   = Math.min(100, Math.round((verifiedCount / Math.max(allNodes.length, 1)) * 100));

  // Fix 4: sort by severity first (danger > resource > safe), then newest first
  const SEVERITY_ORDER = { danger: 0, resource: 1, safe: 2 };
  const sortedAlerts = Object.values(nodes)
    .filter(n => n && n.message)
    .sort((a, b) => {
      const aSev = SEVERITY_ORDER[a.type] ?? 2;
      const bSev = SEVERITY_ORDER[b.type] ?? 2;
      if (aSev !== bSev) return aSev - bSev;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

  const resourceList = [...resourceNodes]
    .sort((a, b) => b.timestamp - a.timestamp);

  /* ── Render ── */
  return (
    <>
      {/* Scanlines */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=JetBrains+Mono:wght@400;500&display=swap');
        :root {
          --bg: #050508; --surface: #0A0A0F; --border: #1A1A2E;
          --green: #00FF94; --orange: #FF6B35; --red: #FF2D55;
          --cyan: #00D4FF; --muted: #4A4A6A; --text: #E8E8F0;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { height: 100%; background: #050508; }
        body::before {
          content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 9999;
          background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.6) 2px, rgba(0,0,0,0.6) 3px);
          opacity: 0.03;
        }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0A0A0F; }
        ::-webkit-scrollbar-thumb { background: #00FF94; border-radius: 2px; }
        .leaflet-container { background: #0A0F1A !important; }
        .leaflet-popup-content-wrapper { background: #0A0A0F; border: 1px solid #1A1A2E; color: #00FF94; font-family: 'JetBrains Mono',monospace; font-size: 12px; border-radius: 3px; }
        .leaflet-popup-tip { background: #0A0A0F; }
        .leaflet-control-zoom a { background: #0A0A0F !important; color: #00FF94 !important; border-color: #1A1A2E !important; font-family: 'Space Mono',monospace; }
        .leaflet-control-attribution { background: rgba(10,10,15,0.85) !important; color: #4A4A6A !important; font-family: 'JetBrains Mono',monospace; font-size: 9px; }
        .leaflet-control-attribution a { color: #4A4A6A !important; }
        @keyframes pulse-danger { 0%,100%{opacity:0.6} 50%{opacity:1} }
        @keyframes dash-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .danger-pulse { animation: pulse-danger 1.8s ease-in-out infinite; }
      `}</style>

      <div style={{
        height:     "100vh",
        width:      "100vw",
        overflow:   "hidden",
        display:    "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color:      "var(--text)",
        fontFamily: "'JetBrains Mono',monospace",
      }}>

        {/* ── TOP BAR ── */}
        <header style={{
          height:        48,
          minHeight:     48,
          display:       "flex",
          alignItems:    "center",
          justifyContent: "space-between",
          padding:       "0 20px",
          background:    "var(--surface)",
          borderBottom:  "1px solid var(--border)",
          flexShrink:    0,
          zIndex:        200,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 13, color: "var(--green)", textShadow: "0 0 8px rgba(0,255,148,0.4)", letterSpacing: "0.06em" }}>
              ◈ GHOSTNET AID DASHBOARD
            </span>
            <span style={{ color: "var(--border)", fontSize: 14 }}>|</span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.14em", color: "var(--muted)", textTransform: "uppercase" }}>
              Humanitarian Operations View
            </span>
            <span style={{ color: "var(--border)", fontSize: 14 }}>|</span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.08em", color: peerCount > 1 ? "var(--green)" : "var(--orange)" }}>
              {peerCount > 1 ? `● ${peerCount} NODES CONNECTED` : "◌ AWAITING MESH..."}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)", letterSpacing: "0.04em" }}>
              {clock}
            </span>
            <Link to="/" style={{ textDecoration: "none" }}>
              <button style={{
                background:    "transparent",
                border:        "1px solid rgba(0,255,148,0.35)",
                color:         "var(--green)",
                fontFamily:    "'Space Mono',monospace",
                fontSize:      9,
                fontWeight:    700,
                letterSpacing: "0.1em",
                padding:       "5px 12px",
                cursor:        "pointer",
                borderRadius:  2,
                transition:    "all 0.15s",
              }}
              onMouseEnter={e => e.target.style.background = "rgba(0,255,148,0.08)"}
              onMouseLeave={e => e.target.style.background = "transparent"}
              >
                [ BACK TO MESH ]
              </button>
            </Link>
          </div>
        </header>

        {/* ── STAT CARDS ROW ── */}
        <div style={{
          display:   "flex",
          gap:       10,
          padding:   "10px 16px",
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
        }}>
          <StatCard
            label="Active Nodes"
            value={allNodes.length}
            color="var(--green)"
            sublabel={`${gpsNodes.length} GPS-confirmed`}
          />
          <StatCard
            label="Danger Zones"
            value={dangerNodes.length}
            color="var(--red)"
            sublabel={dangerNodes.length > 0 ? "IMMEDIATE ATTENTION" : "None detected"}
          />
          <StatCard
            label="Resource Nodes"
            value={resourceNodes.length}
            color="var(--cyan)"
            sublabel={`${resourceNodes.length > 0 ? "Operational" : "None confirmed"}`}
          />
          <StatCard
            label="Critical Reports"
            value={criticalNodes.length}
            color="var(--orange)"
            sublabel={criticalNodes.length > 0 ? "⚠ REQUIRES RESPONSE" : "Situation stable"}
          />
        </div>

        {/* ── MAIN CONTENT ── */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>

          {/* ── LEFT: MAP ── */}
          <div style={{ flex: "0 0 60%", position: "relative", borderRight: "1px solid var(--border)" }}>
            <MapContainer
              center={[20.5937, 78.9629]}
              zoom={5}
              style={{ width: "100%", height: "100%" }}
              zoomControl={true}
              attributionControl={true}
            >
              <MapInvalidator />
              <MapFitter nodes={nodes} />
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution="&copy; OpenStreetMap &copy; CARTO"
                subdomains="abcd"
                maxZoom={19}
              />

              {allNodes.map(node => {
                if (node.lat == null || node.lng == null) return null;
                const color   = nodeColor(node.type);
                const isDanger = node.type === "danger";
                const sev     = severityFromNode(node);
                return (
                  <CircleMarker
                    key={node.id}
                    center={[node.lat, node.lng]}
                    radius={isDanger ? 22 : node.type === "resource" ? 14 : 10}
                    pathOptions={{
                      color,
                      fillColor:   color,
                      fillOpacity: isDanger ? 0.25 : 0.3,
                      weight:      isDanger ? 2.5 : 1.5,
                      dashArray:   !node.verified ? "4 4" : null,
                      className:   isDanger ? "danger-pulse" : "",
                    }}
                  >
                    <Popup>
                      <div style={{ fontFamily: "'JetBrains Mono',monospace", minWidth: 180 }}>
                        <div style={{ color, fontWeight: 700, fontSize: 11, marginBottom: 4 }}>
                          ◈ NODE {node.id}
                          {node.verified === true && <span style={{ color: "#00FF94", marginLeft: 6, fontSize: 9 }}>◈ VERIFIED</span>}
                          {node.verified === false && node.publicKey && <span style={{ color: "#FF6B35", marginLeft: 6 }}>⚠ UNVERIFIED</span>}
                          {node.verified === false && !node.publicKey && <span style={{ color: "#4A4A6A", marginLeft: 6 }}>◌ PENDING KEY</span>}
                        </div>
                        {sev && (
                          <div style={{ color: severityColor(sev), fontSize: 10, marginBottom: 3 }}>
                            ▸ {sev}
                          </div>
                        )}
                        {node.message && (
                          <div style={{ color: "#E8E8F0", fontSize: 10, marginBottom: 3, maxWidth: 220 }}>
                            "{node.message}"
                          </div>
                        )}
                        <div style={{ color: "#4A4A6A", fontSize: 9 }}>
                          {node.locationReal ? `● GPS ±${node.accuracy}m` : "◌ ESTIMATED"} •{" "}
                          {new Date(node.timestamp).toISOString().slice(11, 19)}Z
                        </div>
                        {node.needs?.length > 0 && (
                          <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {node.needs.map(n => (
                              <span key={n} style={{ color, fontSize: 8, border: `1px solid ${color}44`, padding: "1px 4px", borderRadius: 2 }}>
                                {n.toUpperCase()}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </Popup>
                  </CircleMarker>
                );
              })}
            </MapContainer>

            {/* MAP LEGEND */}
            <div style={{
              position: "absolute",
              bottom:   16,
              left:     16,
              zIndex:   1000,
              background: "rgba(10,10,15,0.88)",
              border:   "1px solid var(--border)",
              borderRadius: 3,
              padding:  "10px 14px",
              backdropFilter: "blur(4px)",
            }}>
              <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, letterSpacing: "0.12em", color: "var(--muted)", marginBottom: 8 }}>
                ◈ NODE LEGEND
              </div>
              {[
                { color: "#FF2D55", label: "DANGER ZONE", pulse: true },
                { color: "#00D4FF", label: "RESOURCE NODE" },
                { color: "#00FF94", label: "SAFE NODE" },
                { color: "#FF6B35", label: "UNVERIFIED (dashed)", dashed: true },
              ].map(item => (
                <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <circle
                      cx="7" cy="7" r="5"
                      fill={item.color}
                      fillOpacity="0.3"
                      stroke={item.color}
                      strokeWidth="1.5"
                      strokeDasharray={item.dashed ? "3 2" : "none"}
                    />
                  </svg>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--muted)" }}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── RIGHT: PANELS ── */}
          <div style={{
            flex:     "0 0 40%",
            display:  "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}>

            {/* PANEL 1 — PRIORITY ALERTS */}
            <div style={{
              flex:          "0 0 38%",
              display:       "flex",
              flexDirection: "column",
              borderBottom:  "1px solid var(--border)",
              overflow:      "hidden",
            }}>
              <div style={{
                padding:       "10px 14px 8px",
                borderBottom:  "1px solid rgba(255,45,85,0.15)",
                flexShrink:    0,
                display:       "flex",
                justifyContent: "space-between",
                alignItems:    "center",
              }}>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.12em", color: "var(--red)", textTransform: "uppercase" }}>
                  ◈ Priority Alerts
                </span>
                {sortedAlerts.length > 0 && (
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: dangerNodes.length > 0 ? "var(--red)" : "var(--muted)", animation: dangerNodes.length > 0 ? "dash-blink 1.2s step-end infinite" : "none" }}>
                    {dangerNodes.length > 0 ? `${dangerNodes.length} DANGER` : `${sortedAlerts.length} TOTAL`}
                  </span>
                )}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
                {sortedAlerts.length === 0 ? (
                  <div style={{ padding: "12px 14px", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)" }}>
                    ◌ NO REPORTS IN MESH YET
                  </div>
                ) : (
                  sortedAlerts.map(node => {
                    const sev = severityFromNode(node) || "LOW";
                    const sc  = severityColor(sev);
                    // PENDING = no verified property yet (key exchange in progress)
                    const verifyLabel = node.verified === true
                      ? null
                      : node.verified === false && node.publicKey
                        ? <span style={{ color: "var(--orange)", marginLeft: 8 }}>⚠ UNVERIFIED</span>
                        : node.verified === false
                          ? <span style={{ color: "var(--muted)", marginLeft: 8 }}>◌ PENDING KEY</span>
                          : null;
                    return (
                      <div key={node.id} style={{
                        padding:      "8px 14px",
                        borderBottom: "1px solid rgba(26,26,46,0.5)",
                        display:      "flex",
                        gap:          10,
                      }}>
                        <div style={{
                          width: 8, height: 8, borderRadius: "50%",
                          background: sc, marginTop: 4, flexShrink: 0,
                          boxShadow: `0 0 6px ${sc}`,
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: sc, letterSpacing: "0.08em" }}>
                              {sev}  NODE {node.id}
                            </span>
                            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--muted)" }}>
                              {new Date(node.timestamp).toISOString().slice(11, 19)}Z
                            </span>
                          </div>
                          {node.message && (
                            <div style={{
                              fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--text)",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 2,
                            }}>
                              "{node.message}"
                            </div>
                          )}
                          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "var(--muted)" }}>
                            {node.locationReal ? `● GPS CONFIRMED ±${node.accuracy}m` : "◌ GPS ESTIMATED"}
                            {verifyLabel}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* PANEL 2 — RESOURCE REGISTRY */}
            <div style={{
              flex:          "0 0 30%",
              display:       "flex",
              flexDirection: "column",
              borderBottom:  "1px solid var(--border)",
              overflow:      "hidden",
            }}>
              <div style={{
                padding:      "10px 14px 8px",
                borderBottom: "1px solid rgba(0,212,255,0.12)",
                flexShrink:   0,
              }}>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.12em", color: "var(--cyan)", textTransform: "uppercase" }}>
                  ◈ Resource Registry
                </span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
                {resourceList.length === 0 ? (
                  <div style={{ padding: "12px 14px", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)" }}>
                    ◌ NO RESOURCE NODES CONFIRMED
                  </div>
                ) : (
                  resourceList.map(node => {
                    const primaryNeed = node.needs?.[0] || "resource";
                    return (
                      <div key={node.id} style={{
                        padding:      "7px 14px",
                        borderBottom: "1px solid rgba(26,26,46,0.5)",
                        display:      "flex",
                        alignItems:   "center",
                        gap:          10,
                      }}>
                        <span style={{ fontSize: 14, flexShrink: 0 }}>{needIcon(primaryNeed)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: "var(--cyan)", letterSpacing: "0.08em" }}>
                              {primaryNeed.toUpperCase().padEnd(8)}  NODE {node.id}
                            </span>
                            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: "var(--muted)" }}>
                              {new Date(node.timestamp).toISOString().slice(11, 19)}Z
                            </span>
                          </div>
                          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "var(--muted)", marginTop: 2 }}>
                            {node.locationReal ? `● GPS CONFIRMED ±${node.accuracy}m` : "◌ GPS ESTIMATED"}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* PANEL 3 — MESH HEALTH */}
            <div style={{
              flex:          1,
              display:       "flex",
              flexDirection: "column",
              overflow:      "hidden",
              minHeight:     0,
            }}>
              <div style={{
                padding:      "10px 14px 8px",
                borderBottom: "1px solid rgba(0,255,148,0.1)",
                flexShrink:   0,
              }}>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.12em", color: "var(--green)", textTransform: "uppercase" }}>
                  ◈ Mesh Health
                </span>
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px" }}>
                {[
                  { label: "TOTAL NODES",       val: allNodes.length.toString() },
                  { label: "GPS CONFIRMED",      val: `${gpsNodes.length}  (${allNodes.length ? Math.round(gpsNodes.length / allNodes.length * 100) : 0}%)` },
                  { label: "WITH MESSAGES",      val: activeMessages.length.toString() },
                  { label: "LAST SYNC",          val: lastSync },
                ].map(row => (
                  <div key={row.label} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "4px 0", borderBottom: "1px solid rgba(26,26,46,0.3)",
                  }}>
                    <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.08em", color: "var(--muted)" }}>
                      {row.label}
                    </span>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 500, color: "var(--text)" }}>
                      {row.val}
                    </span>
                  </div>
                ))}

                {/* 3-state crypto verification rows */}
                <div style={{ marginTop: 6, marginBottom: 2 }}>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, letterSpacing: "0.12em", color: "var(--muted)" }}>
                    — CRYPTO VERIFICATION —
                  </span>
                </div>
                {[
                  {
                    label: "VERIFIED",
                    val:   `${verifiedCount}  (${allNodes.length ? Math.round(verifiedCount / allNodes.length * 100) : 0}%)`,
                    color: "var(--green)",
                    icon:  "◈",
                  },
                  {
                    label: "UNVERIFIED",
                    val:   `${unverifiedCount}  ${unverifiedCount > 0 ? "⚠" : "✓"}`,
                    color: unverifiedCount > 0 ? "var(--orange)" : "var(--text)",
                    icon:  unverifiedCount > 0 ? "⚠" : "◌",
                    warn:  unverifiedCount > 0,
                  },
                  {
                    label: "PENDING KEY EXCHANGE",
                    val:   `${pendingCount}  ${pendingCount > 0 ? "◌" : "✓"}`,
                    color: pendingCount > 0 ? "var(--muted)" : "var(--text)",
                    icon:  "◌",
                  },
                ].map(row => (
                  <div key={row.label} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "4px 0", borderBottom: "1px solid rgba(26,26,46,0.3)",
                  }}>
                    <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.08em", color: "var(--muted)" }}>
                      {row.label}
                    </span>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 500, color: row.color }}>
                      {row.val}
                    </span>
                  </div>
                ))}

                {/* Uplink quality bar */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(26,26,46,0.3)" }}>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, letterSpacing: "0.08em", color: "var(--muted)" }}>
                    UPLINK QUALITY
                  </span>
                  <UplinkBar pct={uplinkQuality} />
                </div>

                {/* Situation report button */}
                <button
                  onClick={() => { setReportKey(k => k + 1); setShowReport(true); }}
                  style={{
                    width:         "100%",
                    marginTop:     12,
                    padding:       "9px 0",
                    background:    "transparent",
                    border:        "1px solid rgba(0,255,148,0.3)",
                    color:         "var(--green)",
                    fontFamily:    "'Space Mono',monospace",
                    fontSize:      9,
                    fontWeight:    700,
                    letterSpacing: "0.1em",
                    cursor:        "pointer",
                    borderRadius:  2,
                    transition:    "all 0.15s",
                  }}
                  onMouseEnter={e => { e.target.style.background = "rgba(0,255,148,0.07)"; e.target.style.boxShadow = "0 0 12px rgba(0,255,148,0.1)"; }}
                  onMouseLeave={e => { e.target.style.background = "transparent"; e.target.style.boxShadow = "none"; }}
                >
                  [ GENERATE SITUATION REPORT ]
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── SITUATION REPORT MODAL ── */}
      {showReport && (
        <SituationReportModal
          key={reportKey}
          nodes={nodes}
          onClose={() => setShowReport(false)}
        />
      )}
    </>
  );
}
