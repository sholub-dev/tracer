import { useCurrentFrame, interpolate } from "remotion";
import { palette } from "../styles/palette";

type PageId = "dashboard" | "debug" | "monitors" | "settings";

interface SessionItem {
  label: string;
  active?: boolean;
}

interface AppShellProps {
  activePage: PageId;
  children: React.ReactNode;
  fadeInFrame?: number;
  /** Session/dashboard list items shown under active nav */
  sessionItems?: SessionItem[];
  /** Label for the "+ New" button, e.g. "New chat", "New dashboard" */
  newItemLabel?: string;
  /** Show alert count badge on Monitors nav */
  monitorAlertCount?: number;
}

/* ── SVG Nav Icons (exact copies from Sidebar.tsx) ── */
const NavIconSvg: React.FC<{ page: PageId; color: string }> = ({ page, color }) => {
  const props = {
    width: 16,
    height: 16,
    fill: "none",
    stroke: color,
    strokeWidth: 1.5,
  };
  switch (page) {
    case "dashboard":
      return (
        <svg {...props} viewBox="0 0 16 16">
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
        </svg>
      );
    case "debug":
      return (
        <svg {...props} viewBox="0 0 16 16">
          <path d="M8 1.5L14.5 8L8 14.5L1.5 8Z" />
        </svg>
      );
    case "monitors":
      return (
        <svg {...props} viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="6" />
        </svg>
      );
    case "settings":
      return (
        <svg {...props} viewBox="0 0 16 16">
          <path d="M3 4.5h10M3 8h10M3 11.5h10" />
        </svg>
      );
  }
};

/* ── Logo SVG (green diamond, from logo.svg) ── */
const LogoSvg: React.FC = () => (
  <svg width={24} height={24} viewBox="0 0 32 32">
    <path
      d="M16 3.27 28.73 16 16 28.73 3.27 16Z M16 10.34 21.66 16 16 21.66 10.34 16Z"
      fill={palette.success}
      fillRule="evenodd"
    />
  </svg>
);

const NAV_ITEMS: { page: PageId; label: string }[] = [
  { page: "dashboard", label: "Dashboard" },
  { page: "debug", label: "Debug" },
  { page: "monitors", label: "Monitors" },
];

export const AppShell: React.FC<AppShellProps> = ({
  activePage,
  children,
  fadeInFrame = 0,
  sessionItems,
  newItemLabel,
  monitorAlertCount = 0,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [fadeInFrame, fadeInFrame + 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        opacity,
        width: 1280,
        height: 720,
        display: "flex",
        backgroundColor: palette.shell,
        fontFamily: "Inter, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* ── Sidebar ── */}
      <div
        style={{
          width: 208,
          backgroundColor: palette.sidebar,
          borderRight: `1px solid ${palette.border}`,
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div style={{ padding: 24 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <LogoSvg />
            <span
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: palette.accent,
              }}
            >
              OKO
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: palette.textSecondary,
              marginTop: 4,
            }}
          >
            Observability Platform
          </div>
        </div>

        {/* Main nav */}
        <nav
          style={{
            flex: 1,
            padding: "0 12px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {NAV_ITEMS.map(({ page, label }) => {
            const isActive = activePage === page;
            const iconColor = isActive ? palette.accent : palette.textSecondary;
            return (
              <div key={page}>
                {/* Nav button */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 12px",
                    fontSize: 14,
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? palette.accent : palette.textSecondary,
                    backgroundColor: isActive ? palette.accentLight : "transparent",
                    borderLeft: `2px solid ${isActive ? palette.accent : "transparent"}`,
                    borderRadius: 2,
                  }}
                >
                  <span
                    style={{
                      width: 20,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <NavIconSvg page={page} color={iconColor} />
                  </span>
                  {label}
                  {/* Alert count badge for monitors */}
                  {page === "monitors" && monitorAlertCount > 0 && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        fontWeight: 500,
                        color: palette.error,
                      }}
                    >
                      {monitorAlertCount}
                    </span>
                  )}
                </div>

                {/* Session/Dashboard list under active nav */}
                {isActive && sessionItems && (
                  <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                    {/* New item button */}
                    {newItemLabel && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          paddingLeft: 36,
                          paddingRight: 12,
                          paddingTop: 6,
                          paddingBottom: 6,
                          fontSize: 12,
                          color: palette.textSecondary,
                        }}
                      >
                        <span style={{ fontSize: 10 }}>+</span>
                        {newItemLabel}
                      </div>
                    )}
                    {/* List items */}
                    {sessionItems.map((item, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          paddingLeft: 36,
                          paddingRight: 8,
                          paddingTop: 6,
                          paddingBottom: 6,
                          fontSize: 12,
                          color: item.active ? palette.accent : palette.textSecondary,
                          backgroundColor: item.active ? palette.accentLight : "transparent",
                          fontWeight: item.active ? 500 : 400,
                          overflow: "hidden",
                          whiteSpace: "nowrap" as const,
                          textOverflow: "ellipsis",
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
                          {item.label}
                        </span>
                        <span style={{ fontSize: 10, color: palette.textSecondary, flexShrink: 0 }}>
                          ×
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Settings (bottom) */}
        <div style={{ padding: "0 12px 8px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 12px",
              fontSize: 14,
              color:
                activePage === "settings" ? palette.accent : palette.textSecondary,
              backgroundColor:
                activePage === "settings" ? palette.accentLight : "transparent",
              borderLeft: `2px solid ${
                activePage === "settings" ? palette.accent : "transparent"
              }`,
              borderRadius: 2,
            }}
          >
            <span
              style={{
                width: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <NavIconSvg
                page="settings"
                color={
                  activePage === "settings" ? palette.accent : palette.textSecondary
                }
              />
            </span>
            Settings
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: 16,
            borderTop: `1px solid ${palette.border}`,
            color: palette.textSecondary,
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 10,
              letterSpacing: "0.05em",
            }}
          >
            v0.1.0
          </span>
        </div>
      </div>

      {/* ── Main content ── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
};
