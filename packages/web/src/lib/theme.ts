// Paper, Pencil, Pen — near-monochrome editorial theme with pen-blue accent
// Single source of truth for ALL design decisions.
// Every component imports from this file. To retheme the app, edit here.
//
// Accent (pen blue): #2b5ea7 — used sparingly for interactive elements

/** Raw hex color values for use in JS contexts (charts, canvas, inline styles). */
export const colors = {
  paper: "#fafaf8",
  paperMid: "#f5f4f0",
  paperDark: "#eeece7",
  ink: "#2c2c2c",
  inkLight: "#444444",
  inkMuted: "#666666",
  inkFaint: "#9c9890",
  border: "#d4d2cd",
  borderLight: "#e8e6e1",
  pen: "#2b5ea7",
  error: "#b33a2a",
  success: "#2a7a4a",
  warn: "#a07020",
} as const;

export const theme = {
  // ── Layout ──
  shell: "bg-[#fafaf8] text-[#2c2c2c] font-sans",

  // ── Sidebar (light paper margin) ──
  sidebar: "bg-[#f7f6f3] border-r border-[#d4d2cd] font-sans",
  sidebarLogo: "text-[#2b5ea7]",
  sidebarSubtitle: "text-[#666666]",
  navActive: "text-[#2b5ea7] bg-[#eaf0f8] border-l-2 border-[#2b5ea7]",
  navInactive: "text-[#666666] hover:bg-[#eeece7] hover:text-[#2b5ea7] border-l-2 border-transparent",
  sidebarFooter: "border-t border-[#d4d2cd] text-[#666666]",

  // ── Header ──
  header: "bg-white border-b border-[#d4d2cd]",
  headerTitle: "text-lg font-semibold text-[#2c2c2c] font-sans",

  // ── Page content ──
  page: "p-6 space-y-6 bg-[#fafaf8]",
  pageEmpty: "text-center py-12 text-[#666666]",
  sectionTitle: "text-sm font-medium text-[#666666] mb-3 font-sans",

  // ── Card ──
  card: "rounded bg-white border border-[#d4d2cd] p-6",
  cardTitle: "text-sm text-[#666666] font-sans",
  cardValue: "text-2xl font-bold text-[#2c2c2c] mt-1",
  cardSubtitle: "text-xs text-[#666666] mt-1",

  // ── List item (dashboard rows) ──
  listItem: "bg-white border border-[#d4d2cd] rounded px-4 py-3",
  listItemText: "text-sm text-[#444444] truncate",
  listItemMuted: "text-xs text-[#666666] mt-1",
  listItemHighlight: "text-sm font-mono text-[#2c2c2c]",

  // ── Table ──
  tableContainer: "bg-white rounded border border-[#d4d2cd] overflow-auto max-h-[440px]",
  tableHeaderRow: "bg-[#f5f4f0]",
  tableHeaderCell:
    "px-4 py-3 text-left text-sm font-medium text-[#666666] uppercase tracking-wider font-sans",
  tableRow: "border-b border-[#e8e6e1] hover:bg-[#f5f4f0]/50",
  tableCell: "px-4 py-3 text-sm text-[#444444] max-w-[300px]",
  tableCellText: "line-clamp-2 cursor-default",
  tableEmpty: "px-4 py-8 text-center text-[#666666]",

  // ── Badge ──
  badge: "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium font-sans",
  badgeVariants: {
    error: "bg-[#b33a2a]/10 text-[#b33a2a]",
    warn: "bg-[#a07020]/10 text-[#a07020]",
    info: "bg-[#2b5ea7]/10 text-[#2b5ea7]",
    success: "bg-[#2a7a4a]/10 text-[#2a7a4a]",
    default: "bg-[#f5f4f0] text-[#666666]",
  },

  // ── Spinner ──
  spinner: "border-[#e8e6e1] border-t-[#2b5ea7]",

  // ── Status indicator ──
  statusLabel: "text-sm text-[#666666]",
  statusDot: {
    connected: "bg-[#2a7a4a]",
    disconnected: "bg-[#b33a2a]",
    checking: "bg-[#a07020] animate-pulse",
  },

  // ── Inputs & Buttons ──
  input:
    "w-full bg-white border border-[#d4d2cd] rounded px-3 py-2 text-sm text-[#2c2c2c] placeholder-[#9c9890] focus:outline-none focus:border-[#2b5ea7] font-sans",
  primaryBtn:
    "px-4 py-1.5 text-sm bg-[#2b5ea7] hover:bg-[#234d8a] text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-sans",
  secondaryBtn:
    "px-4 py-1.5 text-sm bg-[#f5f4f0] hover:bg-[#eeece7] text-[#666666] rounded transition-colors disabled:opacity-50 font-sans",
  dangerBtn:
    "px-4 py-1.5 text-sm bg-[#b33a2a]/10 hover:bg-[#b33a2a]/20 text-[#b33a2a] rounded transition-colors disabled:opacity-50 ml-auto font-sans",
  outlineBtn:
    "px-2.5 py-1 text-xs font-medium border border-[#2b5ea7] text-[#2b5ea7] rounded hover:bg-[#2b5ea7] hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[#2b5ea7] font-sans",

  // ── Feedback ──
  successText: "text-sm text-[#2a7a4a] font-sans",
  errorText: "text-sm text-[#b33a2a] font-sans",
  warnText: "text-xs text-[#a07020] font-sans",
  maskedKey: "text-xs text-[#666666] font-mono",

  // ── Chat ──
  chatContainer: "flex flex-col h-full bg-[#fafaf8] font-serif",
  chatMessageArea: "flex-1 overflow-y-auto px-10 py-10",
  chatUserLabel:
    "text-[10px] uppercase tracking-[0.15em] text-[#666666] mb-2 font-sans font-medium",
  chatAssistantLabel:
    "text-[10px] uppercase tracking-[0.15em] text-[#2b5ea7] mb-2 font-sans font-medium",
  chatUserMessage: "text-[#2c2c2c] text-base leading-[1.8] [overflow-wrap:break-word]",
  chatAssistantMessage: "text-[#444444] text-base leading-[1.8] [overflow-wrap:break-word]",
  chatSeparator: "my-6 border-b border-[#e8e6e1]",
  chatInputArea: "px-10 py-5 bg-white border-t border-[#d4d2cd]",
  chatInput:
    "flex-1 bg-white border border-[#d4d2cd] rounded px-4 py-2.5 text-base text-[#2c2c2c] placeholder-[#9c9890] focus:outline-none focus:border-[#2b5ea7] disabled:opacity-50 font-serif resize-none overflow-y-auto max-h-40",
  chatButton:
    "px-5 py-2.5 text-sm bg-[#2b5ea7] text-white font-sans font-medium rounded hover:bg-[#234d8a] disabled:opacity-50 disabled:cursor-not-allowed",
  chatThinking: "text-[#2b5ea7] text-base italic",
  chatEmptyState: "text-[#666666] text-base italic font-serif",
  toolLabel:
    "text-[9px] uppercase tracking-[0.15em] text-[#2b5ea7] font-sans font-semibold mb-2",
  toolLoading: "text-sm italic text-[#2b5ea7] font-sans",
  toolQueryToggle:
    "text-[11px] text-[#666666] font-mono cursor-pointer select-none font-sans",
  toolQueryCode:
    "mt-1 px-3 py-2 text-[12px] font-mono text-[#444444] bg-[#f5f4f0] rounded border border-[#d4d2cd] whitespace-pre-wrap",

  // ── Chat message card (screenshot target) ──
  chatMessageCard: "bg-[#fafaf8] p-4 rounded",

  // ── Chat message actions (hover overlay) ──
  chatMessageActions:
    "absolute right-0 top-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity",
  chatActionButton:
    "p-1 rounded text-[#9c9890] hover:text-[#2b5ea7] hover:bg-[#eaf0f8] transition-colors",
  chatEditTextarea:
    "w-full bg-white border border-[#2b5ea7] rounded px-3 py-2 text-base text-[#2c2c2c] focus:outline-none font-serif leading-[1.8] resize-none",
  chatEditActions: "flex items-center gap-2 mt-2",
  chatEditSave:
    "px-3 py-1 text-xs bg-[#2b5ea7] hover:bg-[#234d8a] text-white rounded transition-colors font-sans",
  chatEditCancel:
    "px-3 py-1 text-xs bg-[#f5f4f0] hover:bg-[#eeece7] text-[#666666] rounded transition-colors font-sans",

  // ── Chat controls ──
  chatStopButton:
    "px-5 py-2.5 text-sm bg-[#f5f4f0] hover:bg-[#eeece7] text-[#666666] font-sans font-medium rounded transition-colors",
  chatContinueButton:
    "px-4 py-2 text-sm bg-[#f5f4f0] hover:bg-[#eeece7] text-[#2b5ea7] font-sans font-medium rounded transition-colors border border-[#d4d2cd]",

  // ── Result extras ──
  resultListItem:
    "px-4 py-2 text-sm text-[#444444] border-b border-[#e8e6e1] last:border-b-0",
  resultErrorMessage:
    "text-sm text-[#b33a2a] font-sans bg-[#b33a2a]/5 border border-[#b33a2a]/20 rounded px-4 py-3 my-2",

  // ── Analysis container (direct mode, blue accent) ──
  analysisContainer: "bg-[#eaf0f8] border border-[#2b5ea7]/20 rounded px-4 py-3 my-3",

  // ── Sub-agent investigation (green accent) ──
  investigationContainer:
    "border-l-2 border-[#2a7a4a] pl-4 my-3",
  investigationLabel:
    "text-[9px] uppercase tracking-[0.15em] text-[#2a7a4a] font-sans font-semibold mb-2",
  analysisBlock:
    "text-sm text-[#444444] bg-[#f2f8f5] border border-[#c8e0d2] rounded px-4 py-3 my-2 leading-relaxed font-sans",
  summaryBlock:
    "text-sm text-[#2c2c2c] bg-[#eaf0f8] border border-[#2b5ea7]/20 rounded px-4 py-3 my-2 leading-relaxed font-sans",
  summaryLabel:
    "text-[9px] uppercase tracking-[0.15em] text-[#2b5ea7] font-sans font-semibold mb-1",

  // ── Charts ──
  chartContainer: "bg-white rounded border border-[#d4d2cd] p-4 my-2",

  // ── Settings card ──
  settingsCard: "bg-white border border-[#d4d2cd] rounded p-4",

  // ── Confirm dialog ──
  dialogBackdrop: "fixed inset-0 z-50 bg-black/20",
  dialogCard: "fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-[#d4d2cd] rounded-lg shadow-lg p-6 w-[340px] font-sans",
  modalCard: "fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-[#d4d2cd] rounded-lg shadow-lg p-6 w-[480px] max-h-[85vh] overflow-y-auto font-sans",
  dialogTitle: "text-sm font-semibold text-[#2c2c2c] mb-2",
  dialogMessage: "text-sm text-[#666666] mb-5",

  // ── Session list (sidebar) ──
  sessionItem:
    "w-full flex items-center gap-2 pl-9 pr-4 py-1.5 text-xs text-[#666666] hover:bg-[#eeece7] hover:text-[#2b5ea7] transition-colors cursor-pointer group",
  sessionItemActive:
    "w-full flex items-center gap-2 pl-9 pr-4 py-1.5 text-xs text-[#2b5ea7] bg-[#eaf0f8] cursor-pointer group font-medium",
  sessionDeleteBtn:
    "ml-auto text-[#666666] hover:text-[#b33a2a] transition-colors text-[10px] shrink-0 opacity-0 group-hover:opacity-100",
  sessionNewBtn:
    "w-full flex items-center gap-2 pl-9 pr-3 py-1.5 text-xs text-[#666666] hover:bg-[#eeece7] hover:text-[#2b5ea7] transition-colors",

  // ── Dashboard ──
  dashboardGrid: "flex-1 min-w-0 overflow-auto p-4 bg-[#fafaf8]",
  dashboardChat: "relative border-l border-[#d4d2cd] flex flex-col bg-white shrink-0 overflow-hidden",
  dashboardChatHeader: "flex items-center justify-between px-4 py-3 border-b border-[#d4d2cd]",
  dashboardChatTitle: "text-sm font-medium text-[#2c2c2c] font-sans",
  dashboardChatToggle: "text-xs text-[#666666] hover:text-[#2b5ea7] cursor-pointer font-sans",
  widgetCard: "bg-white border border-[#d4d2cd] rounded h-full flex flex-col overflow-hidden",
  widgetCardHeader: "flex items-center justify-between px-4 py-2 border-b border-[#e8e6e1] cursor-grab",
  widgetCardTitle: "text-xs font-medium text-[#666666] truncate font-sans",
  widgetCardBody: "flex-1 min-h-0 overflow-auto p-3",

  // ── Panel chat (compact, sidebar-style) ──
  panelChatMessage: "text-sm leading-relaxed",
  panelChatUserMessage: "text-sm leading-relaxed text-[#2c2c2c] [overflow-wrap:break-word]",
  panelChatAssistantMessage: "text-sm leading-relaxed text-[#444444] [overflow-wrap:break-word]",
  panelChatEmptyState: "text-[#666666] text-sm italic font-sans",
  panelChatThinking: "text-[#666666] text-sm italic",
  panelChatSeparator: "my-3 border-b border-[#d4d2cd]",
  panelChatInputArea: "px-4 py-3 bg-white border-t border-[#d4d2cd]",
  panelChatInput: "flex-1 bg-white border border-[#d4d2cd] rounded px-3 py-2 text-sm text-[#2c2c2c] placeholder-[#9c9890] focus:outline-none focus:border-[#2b5ea7] disabled:opacity-50 font-sans",
  panelChatTextarea: "flex-1 bg-white border border-[#d4d2cd] rounded px-3 py-2 text-sm text-[#2c2c2c] placeholder-[#9c9890] focus:outline-none focus:border-[#2b5ea7] disabled:opacity-50 font-sans resize-none overflow-y-auto max-h-24",

  // ── Time range picker ──
  timePickerActive: "bg-[#2b5ea7] text-white",
  timePickerInactive: "text-[#666666] border border-[#d4d2cd] hover:text-[#2b5ea7]",

  // ── Chart series palette ──
  chartColors: ["#6b9fd4", "#6bb88a", "#d4806e", "#d4b06b", "#a488c4", "#6bb8aa"],

  // ── Popover (shared pattern: MemoryBadge, CostDisplay, GcpProjectPicker) ──
  popover: "absolute z-30 bg-[#faf8f4] border border-[#e8e3da] rounded-md shadow-lg py-2 px-3",
  popoverWide: "absolute z-30 bg-[#faf8f4] border border-[#e8e3da] rounded-md shadow-lg py-2 px-3 w-72",
  popoverLabel: "text-[10px] uppercase tracking-wider text-[#9c9890] font-sans mb-2",
  popoverRow: "flex items-start gap-2 py-1 text-xs text-[#6b6560] font-sans",
  popoverItemRow: "flex items-center justify-between text-[11px] text-[#6b6560] font-sans py-0.5",
  popoverDivider: "border-t border-[#e8e3da] my-1",
  popoverFootnote: "text-[10px] text-[#9c9890] font-sans mt-1 pt-1 border-t border-[#e8e3da]",

  // ── Session title bar ──
  titleBar: "sticky top-0 z-20 bg-[#faf8f4] px-10 pt-4 pb-4 mb-2 border-b border-[#e8e3da]",
  titleText: "text-base font-serif font-medium text-[#2b5ea7] tracking-tight",

  // ── Meta text (secondary/muted info) ──
  metaText: "text-[10px] text-[#9c9890] font-sans",
  metaTextHover: "text-[10px] text-[#9c9890] font-sans hover:text-[#6b6560] transition-colors",
  metaLink: "text-xs text-[#666666] hover:text-[#2b5ea7] font-sans transition-colors",

  // ── Indicators ──
  streamingDot: "inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse",
  tokenSummary: "text-[10px] text-[#9c9890] font-sans tracking-wide hover:text-[#6b6560] transition-colors cursor-default",

  // ── Version badge ──
  versionBadge: "font-mono text-[10px] tracking-wider inline-flex items-center gap-1.5",
} as const;
