import { getCurrentWindow } from "@tauri-apps/api/window";

function TrafficLight({ color, onClick, title }: { color: string; onClick: () => void; title: string }) {
  return (
    <button
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 12,
        height: 12,
        borderRadius: 999,
        background: color,
        border: "none",
        padding: 0,
        cursor: "pointer",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.12)",
      }}
    />
  );
}

export function TitleBar() {
  const win = getCurrentWindow();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 48,
        background: "rgba(250, 249, 246, 0.96)",
        borderBottom: "1px solid rgba(0, 0, 0, 0.05)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        userSelect: "none",
        flexShrink: 0,
        position: "relative",
        zIndex: 2,
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "0 14px 0 14px",
          cursor: "default",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: 56 }}>
          <TrafficLight color="#ff5f57" title="Закрыть" onClick={() => win.close()} />
          <TrafficLight color="#febc2e" title="Свернуть" onClick={() => win.minimize()} />
          <TrafficLight color="#28c840" title="Развернуть" onClick={() => win.toggleMaximize()} />
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,0.72)", letterSpacing: "-0.02em" }}>
          Talkis
        </div>

        <div style={{ width: 56 }} />
      </div>
    </div>
  );
}
