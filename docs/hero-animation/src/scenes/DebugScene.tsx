import { useCurrentFrame, interpolate } from "remotion";
import { AppShell } from "../components/AppShell";
import { ChatMessage } from "../components/ChatMessage";
import { TypingAnimation } from "../components/TypingAnimation";
import { palette } from "../styles/palette";

const USER_QUESTION = "Why is checkout-service throwing 500 errors?";

const NRQL_QUERY =
  "SELECT count(*) FROM Transaction WHERE appName = 'checkout-service' AND httpResponseCode >= 500 SINCE 1 hour ago TIMESERIES";

const ANALYSIS_TEXT =
  "Error rate spiked 340% at 14:23 UTC. Correlates with deployment v2.4.1 — the payment validation endpoint is returning 500s due to a missing null check on discount codes.";

// Chart data: error spike pattern
const CHART_DATA = [2, 3, 2, 4, 3, 5, 4, 6, 45, 68, 72, 65, 58, 42, 38];

export const DebugScene: React.FC = () => {
  const frame = useCurrentFrame();

  // Scene timing (relative to scene start):
  // 0-30:    App shell fades in with empty chat
  // 30-90:   User types question
  // 90-180:  AI response appears (sub-agent, query, chart, analysis)

  const investigationOpacity = interpolate(frame, [90, 100], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const investigationY = interpolate(frame, [90, 100], [12, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const queryOpacity = interpolate(frame, [100, 108], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const chartOpacity = interpolate(frame, [110, 118], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const chartDrawProgress = interpolate(frame, [118, 148], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const analysisOpacity = interpolate(frame, [140, 148], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const analysisChars = interpolate(frame, [148, 178], [0, ANALYSIS_TEXT.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const maxVal = Math.max(...CHART_DATA);
  const chartW = 500;
  const chartH = 100;
  const visibleBars = Math.ceil(chartDrawProgress * CHART_DATA.length);

  return (
    <AppShell
      activePage="debug"
      fadeInFrame={0}
      sessionItems={[{ label: "checkout-service errors", active: true }]}
      newItemLabel="New chat"
      monitorAlertCount={1}
    >
      {/* Debug page has NO header — chat fills entire content area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          backgroundColor: palette.shell,
          fontFamily: "Georgia, serif",
        }}
      >
        {/* Chat message area */}
        <div
          style={{
            flex: 1,
            padding: "40px 40px",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 0,
          }}
        >
          {/* User message */}
          <ChatMessage label="YOU" fadeInFrame={20}>
            <TypingAnimation
              text={USER_QUESTION}
              startFrame={30}
              charsPerFrame={1}
              color={palette.textPrimary}
            />
          </ChatMessage>

          {/* Separator */}
          {frame >= 85 && (
            <div
              style={{
                borderBottom: `1px solid ${palette.borderLight}`,
                margin: "24px 0",
                opacity: interpolate(frame, [85, 90], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            />
          )}

          {/* AI Response */}
          {frame >= 90 && (
            <div
              style={{
                opacity: investigationOpacity,
                transform: `translateY(${investigationY}px)`,
              }}
            >
              <ChatMessage label="OKO" labelColor={palette.accent} fadeInFrame={90}>
                {/* Sub-agent investigation block */}
                <div
                  style={{
                    borderLeft: `2px solid ${palette.success}`,
                    paddingLeft: 16,
                    marginTop: 12,
                  }}
                >
                  {/* Investigation label */}
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.15em",
                      color: palette.success,
                      marginBottom: 8,
                      fontFamily: "Inter, system-ui, sans-serif",
                    }}
                  >
                    Sub-agent Investigation
                  </div>

                  {/* NRQL Query */}
                  {frame >= 100 && (
                    <div
                      style={{
                        opacity: queryOpacity,
                        fontSize: 12,
                        fontFamily: "monospace",
                        color: palette.textBody,
                        backgroundColor: palette.cardBg,
                        padding: "8px 12px",
                        borderRadius: 4,
                        border: `1px solid ${palette.border}`,
                        marginBottom: 10,
                        lineHeight: 1.5,
                      }}
                    >
                      {NRQL_QUERY}
                    </div>
                  )}

                  {/* Chart */}
                  {frame >= 110 && (
                    <div
                      style={{
                        opacity: chartOpacity,
                        backgroundColor: palette.white,
                        border: `1px solid ${palette.border}`,
                        borderRadius: 4,
                        padding: "10px 14px",
                        marginBottom: 10,
                      }}
                    >
                      <svg
                        width={chartW}
                        height={chartH}
                        viewBox={`0 0 ${chartW} ${chartH}`}
                      >
                        {[0, 0.5, 1].map((pct) => (
                          <line
                            key={pct}
                            x1={0}
                            y1={chartH * (1 - pct)}
                            x2={chartW}
                            y2={chartH * (1 - pct)}
                            stroke={palette.borderLight}
                            strokeWidth={1}
                          />
                        ))}
                        {CHART_DATA.slice(0, visibleBars).map((val, i) => {
                          const barW = (chartW / CHART_DATA.length) * 0.7;
                          const gap = (chartW / CHART_DATA.length) * 0.3;
                          const barH = (val / maxVal) * (chartH - 10);
                          const x = i * (barW + gap) + gap / 2;
                          const isSpike = val > 30;
                          return (
                            <rect
                              key={i}
                              x={x}
                              y={chartH - barH}
                              width={barW}
                              height={barH}
                              rx={2}
                              fill={isSpike ? palette.error : palette.chart[0]}
                              opacity={0.85}
                            />
                          );
                        })}
                      </svg>
                    </div>
                  )}

                  {/* Analysis */}
                  {frame >= 140 && (
                    <div
                      style={{
                        opacity: analysisOpacity,
                        fontSize: 14,
                        color: palette.textBody,
                        backgroundColor: palette.successBg,
                        border: `1px solid ${palette.successBorder}`,
                        borderRadius: 4,
                        padding: "10px 14px",
                        lineHeight: 1.7,
                        fontFamily: "Inter, system-ui, sans-serif",
                      }}
                    >
                      {ANALYSIS_TEXT.slice(0, Math.floor(analysisChars))}
                      {Math.floor(analysisChars) < ANALYSIS_TEXT.length && (
                        <span
                          style={{
                            display: "inline-block",
                            width: 2,
                            height: "1em",
                            backgroundColor: palette.success,
                            marginLeft: 1,
                            verticalAlign: "text-bottom",
                            opacity: Math.sin(frame * 0.3) > 0 ? 1 : 0,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </ChatMessage>
            </div>
          )}
        </div>

        {/* Input bar — matches real theme.chatInputArea */}
        <div
          style={{
            padding: "20px 40px",
            borderTop: `1px solid ${palette.border}`,
            backgroundColor: palette.white,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              flex: 1,
              border: `1px solid ${palette.border}`,
              borderRadius: 4,
              padding: "10px 16px",
              fontSize: 16,
              color: palette.textMuted,
              fontFamily: "Georgia, serif",
            }}
          >
            {frame < 30 ? "Ask a debugging question..." : ""}
          </div>
          <div
            style={{
              padding: "10px 20px",
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
    </AppShell>
  );
};
