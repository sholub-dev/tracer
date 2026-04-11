import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { AppShell } from "../components/AppShell";
import { palette } from "../styles/palette";

export const MonitorsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardSpring = spring({
    frame: frame - 5,
    fps,
    config: { damping: 14, stiffness: 150, mass: 0.7 },
  });

  const cardOpacity = interpolate(cardSpring, [0, 1], [0, 1]);
  const cardScale = interpolate(cardSpring, [0, 1], [0.97, 1]);

  // Alert badge pulse
  const badgePulse = interpolate(
    Math.sin(frame * 0.15),
    [-1, 1],
    [0.8, 1],
  );

  return (
    <AppShell
      activePage="monitors"
      fadeInFrame={0}
      monitorAlertCount={1}
    >
      {/* Header — matches real Monitors header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 24px",
          backgroundColor: palette.white,
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        <span
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: palette.textPrimary,
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          Monitors
        </span>
        <span
          style={{
            fontSize: 12,
            color: palette.textSecondary,
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          Hide Chat
        </span>
      </div>

      {/* Content area with monitor list + chat panel */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Monitor list */}
        <div
          style={{
            flex: 1,
            padding: 16,
            backgroundColor: palette.shell,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* Monitor Card — matches real card style */}
          <div
            style={{
              opacity: cardOpacity,
              transform: `scale(${cardScale})`,
              backgroundColor: palette.white,
              border: `1px solid ${palette.border}`,
              borderRadius: 4,
              padding: 24,
              fontFamily: "Inter, system-ui, sans-serif",
            }}
          >
            {/* Header row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: palette.textPrimary,
                }}
              >
                SOME-SERVICE Log Count Alert
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "3px 10px",
                    borderRadius: 9999,
                    opacity: badgePulse,
                    backgroundColor: palette.errorBg,
                    color: palette.error,
                  }}
                >
                  ALERT
                </span>
                <span style={{ fontSize: 12, color: palette.textSecondary }}>
                  Show Chart
                </span>
                <span style={{ fontSize: 12, color: palette.textSecondary }}>
                  Delete
                </span>
              </div>
            </div>

            {/* Query info */}
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: palette.textSecondary }}>Query: </span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "monospace",
                  color: palette.textBody,
                  backgroundColor: palette.cardBg,
                  padding: "2px 6px",
                  borderRadius: 3,
                }}
              >
                SELECT count(*) FROM Log WHERE entity.name = &apos;SOME-SERVICE&apos; SINCE 120 seconds ago UNTIL NOW
              </span>
            </div>

            {/* Condition */}
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: palette.textSecondary }}>Condition: </span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "monospace",
                  color: palette.textBody,
                  backgroundColor: palette.cardBg,
                  padding: "2px 6px",
                  borderRadius: 3,
                }}
              >
                result[0].count &gt; 10
              </span>
            </div>

            {/* Metadata */}
            <div
              style={{
                fontSize: 12,
                color: palette.textSecondary,
                marginBottom: 12,
              }}
            >
              Every 60s · Last check: 2/15/2026, 11:15:59 AM · Provider: newrelic
            </div>

            {/* Active Alerts section */}
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: `1px solid ${palette.borderLight}`,
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.15em",
                  color: palette.error,
                  marginBottom: 8,
                }}
              >
                Active Alerts
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  backgroundColor: `${palette.error}08`,
                  border: `1px solid ${palette.error}33`,
                  borderRadius: 4,
                  padding: "8px 12px",
                }}
              >
                <span style={{ fontSize: 12, color: palette.textBody }}>
                  Triggered 2/15/2026, 11:15:59 AM
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: palette.accent,
                    fontWeight: 500,
                  }}
                >
                  Resolve
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Monitor Builder chat panel (right side) */}
        <div
          style={{
            width: 260,
            borderLeft: `1px solid ${palette.border}`,
            backgroundColor: palette.white,
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: `1px solid ${palette.border}`,
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: palette.textPrimary,
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Monitor Builder
            </span>
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                fontSize: 14,
                color: palette.textSecondary,
                fontStyle: "italic",
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Create a monitor...
            </span>
          </div>
          {/* Panel input */}
          <div
            style={{
              padding: "12px 16px",
              borderTop: `1px solid ${palette.border}`,
              display: "flex",
              gap: 8,
            }}
          >
            <div
              style={{
                flex: 1,
                border: `1px solid ${palette.border}`,
                borderRadius: 4,
                padding: "8px 12px",
                fontSize: 14,
                color: palette.textMuted,
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Create a monitor...
            </div>
            <div
              style={{
                padding: "8px 16px",
                backgroundColor: palette.accent,
                color: palette.white,
                borderRadius: 4,
                fontSize: 14,
                fontWeight: 500,
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Send
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
};
