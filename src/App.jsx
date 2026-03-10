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
    // Bytes  0– 3: Node ID as uint32
    view.setUint32(0, parseInt(nodeId, 16));
    // Bytes  4– 7: Latitude  × 1e6 as int32
    view.setInt32(4, Math.round(lat * 1e6));
    // Bytes  8–11: Longitude × 1e6 as int32
    view.setInt32(8, Math.round(lng * 1e6));
    // Bytes 12–15: Unix timestamp (seconds)
    view.setUint32(12, Math.floor(Date.now() / 1000));
    // Bytes 16–19: Status flags bitfield
    let flags = 0;
    flags |= (this.TYPE_CODES[type] ?? 3) & 0x3;
    needs.forEach(need => { flags |= (this.NEED_CODES[need] ?? 0) << 4; });
    view.setUint32(16, flags);
    // Bytes 20–27: Reserved / AI semantic payload
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

const classifyMessage = (text) => {
  const t = text.toLowerCase();
  if (/bomb|explosion|attack|danger|fire|threat|armed|hostile|shot|blast/.test(t)) return "danger";
  if (/food|water|medical|medicine|help|supplies|camp|aid|rescue|doctor|hospital|hungry|hurt|injured/.test(t)) return "resource";
  return "safe";
};

const detectNeeds = (text) => {
  const t     = text.toLowerCase();
  const needs = [];
  if (/water/.test(t))                          needs.push("water");
  if (/food|hungry/.test(t))                    needs.push("food");
  if (/medical|injured|hurt|doctor/.test(t))    needs.push("medical");
  if (/shelter|roof|housing/.test(t))           needs.push("shelter");
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

/* ═══════════════════════════════════════════════════════════════════
   MAP CHILD COMPONENTS
   ═══════════════════════════════════════════════════════════════════ */

/* Forces Leaflet to recalc tile sizes after mount */
function MapInvalidator() {
  const map = useMap();
  useEffect(() => { setTimeout(() => map.invalidateSize(), 120); }, [map]);
  return null;
}

/* Flies the map to the user's real location when it becomes available */
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
function LogEntry({ time, direction, hex, status, type }) {
  const dirColor   = direction === "TX" ? "var(--green)" : "var(--cyan)";
  const typeColor  = nodeColor(type || "safe");
  return (
    <div className="log-entry">
      <span className="log-ts">{time}</span>
      <span className="log-type" style={{ color: dirColor }}>[{direction}]</span>
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
        const color  = nodeColor(node.type);
        const isSelf = node.id === nodeId;
        return (
          <CircleMarker
            key={node.id}
            center={[node.lat, node.lng]}
            radius={isSelf ? 14 : 10}
            pathOptions={{
              color,
              fillColor:   color,
              fillOpacity: 0.3,
              weight:      isSelf ? 2.5 : 2,
            }}
          >
            <Popup>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color }}>
                {isSelf ? "◈ YOU" : `◈ NODE ${node.id}`}
              </span>
              <br />
              {node.locationReal && (
                <>
                  <span style={{ color: "var(--green)", fontSize: 9 }}>
                    ● GPS ± {node.accuracy}m
                  </span>
                  <br />
                </>
              )}
              <span style={{ color: "#E8E8F0", fontSize: 10 }}>
                {node.message || "● ONLINE"}
              </span>
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

  /* ── UI state ── */
  const [blackout,     setBlackout]     = useState(false);
  const [restored,     setRestored]     = useState(false);
  const [message,      setMessage]      = useState("");
  const [networkNodes, setNetworkNodes] = useState({});
  const [peerCount,    setPeerCount]    = useState(1);
  const [packetLog,    setPacketLog]    = useState([]);
  const [syncStatus,   setSyncStatus]   = useState("CONNECTING");
  const [userLocation, setUserLocation] = useState(null);
  const [gpsStatus,    setGpsStatus]    = useState("PENDING"); // PENDING | CONFIRMED | ESTIMATED
  const [gpsAccuracy,  setGpsAccuracy]  = useState(null);

  /* ── Yjs refs ── */
  const ydocRef     = useRef(new Y.Doc());
  const nodesMapRef = useRef(null);
  const providerRef = useRef(null);
  const restoreTimer = useRef(null);

  /* ── Bootstrap Yjs + Geolocation ── */
  useEffect(() => {
    const ydoc = ydocRef.current;

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

    /* Register self once IndexedDB is ready */
    persistence.whenSynced.then(() => {
      setSyncStatus("SYNCED");
      nodesMap.set(nodeId, {
        id:           nodeId,
        lat:          20.5937 + (Math.random() - 0.5) * 20,
        lng:          78.9629 + (Math.random() - 0.5) * 20,
        status:       "SAFE",
        message:      "",
        type:         "safe",
        locationReal: false,
        accuracy:     null,
        timestamp:    Date.now(),
      });

      /* ── Geolocation — request after Yjs is ready ── */
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const { latitude, longitude, accuracy } = position.coords;
            const current = nodesMap.get(nodeId) || {};
            nodesMap.set(nodeId, {
              ...current,
              lat:          latitude,
              lng:          longitude,
              accuracy:     Math.round(accuracy),
              locationReal: true,
            });
            setUserLocation([latitude, longitude]);
            setGpsAccuracy(Math.round(accuracy));
            setGpsStatus("CONFIRMED");
          },
          () => {
            console.log("Location unavailable — using estimated position");
            setGpsStatus("ESTIMATED");
            setUserLocation(null);
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      } else {
        setGpsStatus("ESTIMATED");
      }
    });

    /* React to shared map changes */
    const onMapChange = () => {
      const all = {};
      nodesMap.forEach((value, key) => { if (value) all[key] = value; });
      setNetworkNodes({ ...all });
    };
    nodesMap.observe(onMapChange);

    /* Awareness — live peer count */
    const onAwareness = () => {
      setPeerCount(provider.awareness.getStates().size);
    };
    provider.awareness.on("change", onAwareness);
    provider.awareness.setLocalState({ nodeId, joined: Date.now() });

    return () => {
      nodesMap.unobserve(onMapChange);
      provider.awareness.off("change", onAwareness);
      try { nodesMap.set(nodeId, undefined); } catch (_) {}
      provider.destroy();
      persistence.destroy();
      clearTimeout(restoreTimer.current);
    };
  }, [nodeId]);

  /* ── Blackout toggle ── */
  const handleBlackout = useCallback(() => {
    if (blackout) {
      setBlackout(false);
      setRestored(true);
      clearTimeout(restoreTimer.current);
      restoreTimer.current = setTimeout(() => setRestored(false), 2000);
    } else {
      setRestored(false);
      clearTimeout(restoreTimer.current);
      setBlackout(true);
    }
  }, [blackout]);

  /* ── BROADCAST PACKET ── */
  const handleBroadcast = useCallback(() => {
    const text = message.trim();
    if (!text || !nodesMapRef.current) return;

    const type  = classifyMessage(text);
    const needs = detectNeeds(text);
    const time  = nowZ();

    /* Get current node position from shared map */
    const current = nodesMapRef.current.get(nodeId) || {};
    const lat = current.lat ?? 20.5937;
    const lng = current.lng ?? 78.9629;

    /* Encode binary packet */
    const buffer    = SurvivalPacket.encode(nodeId, lat, lng, "ACTIVE", type, needs);
    const hexString = SurvivalPacket.toHexString(buffer);
    const hexTrunc  = hexString.slice(0, 35) + "...";

    /* Write to Yjs — all peers observe this instantly */
    nodesMapRef.current.set(nodeId, {
      ...current,
      message,
      type,
      needs,
      timestamp: Date.now(),
    });

    /* Append to local packet log */
    setPacketLog(prev => [
      {
        id:        Date.now(),
        time,
        direction: "TX",
        hex:       hexTrunc,
        status:    "BROADCAST",
        type,
      },
      ...prev.slice(0, 49),
    ]);

    setMessage("");
  }, [message, nodeId]);

  /* ── Derived ── */
  const meshFilled  = blackout ? 1 : Math.min(peerCount, 5);
  const remotePeers = Object.values(networkNodes).filter(n => n && n.id !== nodeId);
  const queuedCount = packetLog.filter(l => l.queued).length;

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
          <span style={{
            fontFamily: "'Space Mono',monospace",
            fontSize: 9,
            letterSpacing: "0.1em",
            color: syncStatus === "SYNCED" ? "var(--green)" : "var(--orange)",
          }}>
            {syncStatus === "SYNCED" ? "● SYNCED" : "◌ SYNCING"}
          </span>
          <button
            className={`blackout-toggle font-space${blackout ? " active" : ""}`}
            onClick={handleBlackout}
            aria-label="Toggle blackout mode"
          >
            {blackout ? "⚠ BLACKOUT" : "● UPLINK ACTIVE"}
          </button>
        </div>

      </header>

      {/* ── BANNERS ── */}
      {blackout && (
        <div className="blackout-banner danger banner-enter font-space">
          ⚠ NETWORK BLACKOUT ACTIVE — OPERATING ON LOCAL MESH ONLY — {queuedCount} PACKETS QUEUED
        </div>
      )}
      {restored && !blackout && (
        <div className="blackout-banner restored banner-enter font-space">
          ✓ UPLINK RESTORED — SYNCHRONIZING QUEUED PACKETS
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
              <span className="node-val" style={{ color: "var(--cyan)" }}>
                {peerCount} ONLINE
              </span>
            </div>
            <div className="node-row">
              <span className="node-key">Protocol</span>
              <span className="node-val" style={{ color: "var(--cyan)", fontSize: "10px" }}>
                MESH-V2
              </span>
            </div>

            {/* GPS status row */}
            <div className="node-row" style={{ marginTop: 4 }}>
              <span className="node-key">Location</span>
              {gpsStatus === "PENDING" && (
                <span style={{
                  fontFamily: "'Space Mono',monospace",
                  fontSize: 9,
                  letterSpacing: "0.08em",
                  color: "var(--muted)",
                }}>
                  ◌ ACQUIRING...
                </span>
              )}
              {gpsStatus === "CONFIRMED" && (
                <span style={{
                  fontFamily: "'Space Mono',monospace",
                  fontSize: 9,
                  letterSpacing: "0.08em",
                  color: "var(--green)",
                  textShadow: "0 0 6px rgba(0,255,148,0.3)",
                }}>
                  GPS ± {gpsAccuracy}m
                </span>
              )}
              {gpsStatus === "ESTIMATED" && (
                <span style={{
                  fontFamily: "'Space Mono',monospace",
                  fontSize: 9,
                  letterSpacing: "0.08em",
                  color: "var(--orange)",
                }}>
                  ESTIMATED
                </span>
              )}
            </div>

            {/* GPS confirmation label */}
            <div style={{
              marginTop: 6,
              padding: "4px 8px",
              background: gpsStatus === "CONFIRMED"
                ? "rgba(0,255,148,0.05)"
                : "rgba(255,107,53,0.05)",
              border: `1px solid ${gpsStatus === "CONFIRMED"
                ? "rgba(0,255,148,0.12)"
                : "rgba(255,107,53,0.12)"}`,
              borderRadius: 2,
            }}>
              <span style={{
                fontFamily: "'Space Mono',monospace",
                fontSize: 8,
                letterSpacing: "0.1em",
                color: gpsStatus === "CONFIRMED" ? "var(--green)" : "var(--orange)",
              }}>
                {gpsStatus === "CONFIRMED"
                  ? "◈ LOCATION: GPS CONFIRMED"
                  : gpsStatus === "ESTIMATED"
                    ? "◈ LOCATION: ESTIMATED"
                    : "◈ LOCATION: ACQUIRING GPS"}
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
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleBroadcast();
              }}
            />
            <button className="broadcast-btn" onClick={handleBroadcast}>
              [ BROADCAST PACKET ]
            </button>
          </div>

          <div className="divider" />

          {/* ACTIVE PEERS */}
          <div className="panel-section" style={{ paddingBottom: 14 }}>
            <span className="section-label">◈ Active Peers</span>
            <div className="peer-list">
              {remotePeers.length === 0 ? (
                <div style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 10,
                  color: "var(--muted)",
                  padding: "6px 0",
                }}>
                  ◌ AWAITING PEERS...
                </div>
              ) : (
                remotePeers.map((peer) => {
                  const color = nodeColor(peer.type);
                  return (
                    <div className="peer-item" key={peer.id}>
                      <span className="peer-dot"  style={{ color }}>●</span>
                      <span className="peer-id"   style={{ color }}>{peer.id}</span>
                      <span className="peer-status online">● ONLINE</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

        </aside>

        {/* ── CENTER — live P2P map ── */}
        <main className="panel panel-center">
          <div id="map">
            <GhostMap
              networkNodes={networkNodes}
              nodeId={nodeId}
              userLocation={userLocation}
            />
          </div>
        </main>

        {/* ── RIGHT PANEL ── */}
        <aside className="panel panel-right dot-grid">

          {/* INTEL FEED */}
          <div
            className="panel-section intel-feed-wrap"
            style={{ paddingTop: 14, flex: 1, minHeight: 0 }}
          >
            <span className="section-label" style={{ margin: "0 0 10px 0" }}>◈ Intel Feed</span>
            <div className="intel-feed">
              {Object.values(networkNodes).filter(n => n && n.message).length === 0 ? (
                <p className="intel-placeholder">
                  AWAITING INCOMING PACKETS — INTELLIGENCE SYNTHESIS WILL APPEAR HERE
                </p>
              ) : (
                Object.values(networkNodes)
                  .filter(n => n && n.message)
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .map((node) => {
                    const color  = nodeColor(node.type);
                    const isSelf = node.id === nodeId;
                    return (
                      <div key={node.id} style={{
                        marginBottom: 10,
                        paddingBottom: 10,
                        borderBottom: "1px solid rgba(26,26,46,0.6)",
                      }}>
                        <div style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 3,
                        }}>
                          <span style={{
                            fontFamily: "'Space Mono',monospace",
                            fontSize: 9,
                            color,
                            letterSpacing: "0.08em",
                          }}>
                            ◈ {isSelf ? "YOU" : `NODE ${node.id}`}
                          </span>
                          <span style={{
                            fontFamily: "'JetBrains Mono',monospace",
                            fontSize: 9,
                            color: "var(--muted)",
                          }}>
                            {new Date(node.timestamp).toISOString().slice(11, 19)}Z
                          </span>
                        </div>
                        <div style={{
                          fontFamily: "'JetBrains Mono',monospace",
                          fontSize: 11,
                          color: "var(--text)",
                          lineHeight: 1.6,
                          wordBreak: "break-word",
                        }}>
                          {node.message}
                        </div>
                        {node.needs && node.needs.length > 0 && (
                          <div style={{
                            display: "flex",
                            gap: 4,
                            marginTop: 4,
                            flexWrap: "wrap",
                          }}>
                            {node.needs.map(need => (
                              <span key={need} style={{
                                fontFamily: "'Space Mono',monospace",
                                fontSize: 8,
                                letterSpacing: "0.08em",
                                padding: "1px 5px",
                                border: `1px solid ${color}33`,
                                color,
                                borderRadius: 2,
                              }}>
                                {need.toUpperCase()}
                              </span>
                            ))}
                          </div>
                        )}
                        <div style={{
                          fontFamily: "'Space Mono',monospace",
                          fontSize: 8,
                          color,
                          marginTop: 4,
                          letterSpacing: "0.1em",
                        }}>
                          ▸ {typeLabel(node.type)}
                          {node.locationReal
                            ? <span style={{ color: "var(--green)", marginLeft: 8 }}>● GPS ± {node.accuracy}m</span>
                            : <span style={{ color: "var(--muted)", marginLeft: 8 }}>◌ ESTIMATED</span>
                          }
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          </div>

          <div className="divider" style={{ margin: "10px 14px" }} />

          {/* PACKET LOG */}
          <div
            className="panel-section packet-log-wrap"
            style={{ paddingTop: 0, flex: 1, minHeight: 0 }}
          >
            <span className="section-label" style={{ margin: "0 14px 8px", display: "block" }}>
              ◈ Packet Log
            </span>
            <div className="packet-log">
              {packetLog.length === 0 ? (
                <div style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 10,
                  color: "var(--muted)",
                  padding: "4px 0",
                }}>
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
