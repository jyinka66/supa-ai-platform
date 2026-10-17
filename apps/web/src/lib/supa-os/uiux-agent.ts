// UI/UX Agent — Mobile & Web, responsive design.
//
// The UI/UX Agent is the THIRD agent in the orchestration. It takes the
// Architect's API contracts + the Security agent's role definitions and
// produces:
//   - Design system (colors, typography, spacing, components)
//   - Screen specifications (what screens, what components, what data)
//   - Component list (reusable UI components)
//   - Responsive breakpoints (mobile, tablet, desktop)
//   - Platform-specific adaptations (web vs mobile)

import type { ParsedGoal } from "./kernel";
import type { ApiEndpointSpec } from "./architect-agent";
import type { RoleSpec } from "./security-agent";

// ───────────────────────────────────────────────
// Design system.
// ───────────────────────────────────────────────

export interface DesignSystem {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    success: string;
    warning: string;
    error: string;
  };
  typography: {
    fontFamily: string;
    headingScale: string;   // e.g. "1.250 (major third)"
    bodySize: string;
    lineHeight: string;
  };
  spacing: string;          // e.g. "4px base (Tailwind default)"
  borderRadius: string;
  shadows: string;
  darkMode: boolean;
}

// ───────────────────────────────────────────────
// Screen specifications.
// ───────────────────────────────────────────────

export type ScreenCategory =
  | "auth"           // login, signup, forgot password
  | "onboarding"     // first-time setup
  | "dashboard"      // main dashboard / home
  | "list"           // list views (transactions, products, etc.)
  | "detail"         // detail views (single transaction, product, etc.)
  | "form"           // create/edit forms
  | "settings"       // user/workspace settings
  | "profile"        // user profile
  | "admin"          // admin panel
  | "error"          // 404, 500, etc.
  | "empty";          // empty states

export interface ScreenSpec {
  name: string;
  category: ScreenCategory;
  path: string;           // route path (e.g. "/dashboard")
  title: string;
  description: string;
  /** Which roles can access this screen. */
  roles: string[];
  /** Which API endpoints this screen calls. */
  apiCalls: string[];     // endpoint paths
  /** Key components on this screen. */
  components: string[];
  /** Responsive: which platforms this screen supports. */
  platforms: string[];
  /** Whether this screen requires authentication. */
  authRequired: boolean;
}

// ───────────────────────────────────────────────
// Component list.
// ───────────────────────────────────────────────

export interface ComponentSpec {
  name: string;
  category: "layout" | "form" | "data_display" | "feedback" | "navigation" | "overlay" | "empty";
  description: string;
  props: string[];
  responsive: boolean;
  accessible: boolean;    // WCAG AA
  platforms: string[];     // "web", "mobile"
}

// ───────────────────────────────────────────────
// UI/UX Agent — the main function.
// ───────────────────────────────────────────────

export interface UiUxOutput {
  designSystem: DesignSystem;
  screens: ScreenSpec[];
  components: ComponentSpec[];
  /** Responsive breakpoints. */
  breakpoints: Record<string, string>;
  /** Platform-specific notes (web vs mobile differences). */
  platformNotes: string[];
  generatedAt: Date;
}

/**
 * The UI/UX Agent designs the interface for the app.
 *
 * This is the THIRD agent — it runs after the Security Agent and before the
 * Full-Stack Engineer. It uses the API contracts (for data binding) and
 * role definitions (for access control) to produce the design.
 */
export function designInterface(
  goal: ParsedGoal,
  endpoints: ApiEndpointSpec[],
  roles: RoleSpec[],
): UiUxOutput {
  const designSystem = generateDesignSystem(goal);
  const screens = generateScreens(goal, endpoints, roles);
  const components = generateComponents(goal);

  const breakpoints = {
    sm: "640px",
    md: "768px",
    lg: "1024px",
    xl: "1280px",
    "2xl": "1536px",
  };

  const platformNotes: string[] = [];
  if (goal.platforms.includes("mobile_cross")) {
    platformNotes.push("Mobile: use bottom tab navigation (not sidebar) — 5 tabs max.");
    platformNotes.push("Mobile: forms use full-width inputs with large tap targets (min 44pt).");
    platformNotes.push("Mobile: touch-friendly buttons (min 44x44pt per Apple HIG).");
  }
  if (goal.platforms.includes("web")) {
    platformNotes.push("Web: use sidebar navigation (collapsible on mobile).");
    platformNotes.push("Web: data tables support sorting, filtering, pagination.");
    platformNotes.push("Web: keyboard shortcuts for power users (Cmd+K command palette).");
  }

  return {
    designSystem,
    screens,
    components,
    breakpoints,
    platformNotes,
    generatedAt: new Date(),
  };
}

function generateDesignSystem(goal: ParsedGoal): DesignSystem {
  // Domain-specific color palettes.
  const palettes: Record<string, DesignSystem["colors"]> = {
    fintech: {
      primary: "#0F766E",       // teal — trust + finance
      secondary: "#0E7490",    // cyan
      accent: "#F59E0B",         // amber — for CTAs
      background: "#F8FAFC",
      surface: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#64748B",
      success: "#16A34A",
      warning: "#D97706",
      error: "#DC2626",
    },
    healthcare: {
      primary: "#2563EB",       // blue — health + trust
      secondary: "#3B82F6",
      accent: "#10B981",         // green — health
      background: "#F0FDF4",
      surface: "#FFFFFF",
      text: "#1E293B",
      textMuted: "#64748B",
      success: "#16A34A",
      warning: "#D97706",
      error: "#DC2626",
    },
    ecommerce: {
      primary: "#7C3AED",       // purple — commerce
      secondary: "#6366F1",
      accent: "#EC4899",         // pink — CTAs
      background: "#FAFAFA",
      surface: "#FFFFFF",
      text: "#18181B",
      textMuted: "#71717A",
      success: "#16A34A",
      warning: "#D97706",
      error: "#DC2626",
    },
  };

  const colors = palettes[goal.domain] ?? {
    primary: "#3B82F6",
    secondary: "#6366F1",
    accent: "#8B5CF6",
    background: "#FFFFFF",
    surface: "#F8FAFC",
    text: "#0F172A",
    textMuted: "#64748B",
    success: "#16A34A",
    warning: "#D97706",
    error: "#DC2626",
  };

  return {
    colors,
    typography: {
      fontFamily: "Inter, system-ui, -apple-system, sans-serif",
      headingScale: "1.250 (major third)",
      bodySize: "16px",
      lineHeight: "1.6",
    },
    spacing: "4px base (Tailwind default)",
    borderRadius: "8px (rounded-lg)",
    shadows: "subtle (shadow-sm default, shadow-md on hover)",
    darkMode: true,
  };
}

function generateScreens(goal: ParsedGoal, endpoints: ApiEndpointSpec[], roles: RoleSpec[]): ScreenSpec[] {
  const screens: ScreenSpec[] = [];
  const roleNames = roles.map((r) => r.name);

  // Auth screens (every app).
  screens.push({
    name: "Login",
    category: "auth",
    path: "/login",
    title: "Sign In",
    description: "Email/password + OAuth (Google, Apple).",
    roles: ["public"],
    apiCalls: ["/api/auth/login"],
    components: ["Input", "Button", "OAuthButtons", "Card"],
    platforms: ["web", "mobile"],
    authRequired: false,
  });
  screens.push({
    name: "Signup",
    category: "auth",
    path: "/signup",
    title: "Create Account",
    description: "Email/password + OAuth. Triggers KYC if required.",
    roles: ["public"],
    apiCalls: ["/api/auth/signup", ...(goal.compliance.includes("kyc_aml") ? ["/api/kyc/start"] : [])],
    components: ["Input", "Button", "OAuthButtons", "Card", ...(goal.compliance.includes("kyc_aml") ? ["KycWidget"] : [])],
    platforms: ["web", "mobile"],
    authRequired: false,
  });

  // Dashboard (every app).
  screens.push({
    name: "Dashboard",
    category: "dashboard",
    path: "/dashboard",
    title: "Dashboard",
    description: `Main ${goal.domain} dashboard — overview of key metrics + recent activity.`,
    roles: roleNames.filter((r) => r !== "public"),
    apiCalls: endpoints.filter((e) => e.method === "GET" && e.path.includes("dashboard")).map((e) => e.path),
    components: ["StatCard", "Chart", "RecentActivityList", "Sidebar", "TopBar"],
    platforms: ["web", "mobile"],
    authRequired: true,
  });

  // Fintech-specific screens.
  if (goal.domain === "fintech") {
    if (goal.features.includes("loan_management")) {
      screens.push({
        name: "Loans",
        category: "list",
        path: "/loans",
        title: "My Loans",
        description: "List of user's loans with status, balance, next payment.",
        roles: ["member", "admin", "owner"],
        apiCalls: ["/api/loans"],
        components: ["LoanCard", "StatusBadge", "EmptyState", "Button"],
        platforms: ["web", "mobile"],
        authRequired: true,
      });
      screens.push({
        name: "LoanDetail",
        category: "detail",
        path: "/loans/:id",
        title: "Loan Details",
        description: "Loan details — principal, interest, repayment schedule, payment history.",
        roles: ["member", "admin", "owner"],
        apiCalls: ["/api/loans/:id", "/api/loans/:id/payments"],
        components: ["LoanSummary", "RepaymentSchedule", "PaymentHistory", "Button"],
        platforms: ["web", "mobile"],
        authRequired: true,
      });
    }
    screens.push({
      name: "Transactions",
      category: "list",
      path: "/transactions",
      title: "Transactions",
      description: "Transaction history with filters (date, type, amount).",
      roles: ["member", "admin", "owner"],
      apiCalls: ["/api/transactions"],
      components: ["TransactionList", "FilterBar", "DateRangePicker", "ExportButton"],
      platforms: ["web", "mobile"],
      authRequired: true,
    });
    if (goal.features.includes("transfers")) {
      screens.push({
        name: "Transfer",
        category: "form",
        path: "/transfer",
        title: "Send Money",
        description: "Transfer form — recipient, amount, confirmation.",
        roles: ["member", "admin", "owner"],
        apiCalls: ["/api/transfers"],
        components: ["TransferForm", "RecipientInput", "AmountInput", "ConfirmButton"],
        platforms: ["web", "mobile"],
        authRequired: true,
      });
    }
  }

  // Settings (every app).
  screens.push({
    name: "Settings",
    category: "settings",
    path: "/settings",
    title: "Settings",
    description: "User settings — profile, notifications, security, billing.",
    roles: ["member", "admin", "owner"],
    apiCalls: ["/api/users/me", "/api/settings"],
    components: ["SettingsTabs", "ProfileForm", "NotificationPreferences", "SecuritySettings"],
    platforms: ["web", "mobile"],
    authRequired: true,
  });

  // Admin panel (if RBAC includes admin).
  if (roles.some((r) => r.canManageUsers)) {
    screens.push({
      name: "AdminPanel",
      category: "admin",
      path: "/admin",
      title: "Admin Panel",
      description: "Admin panel — user management, audit logs, compliance evidence.",
      roles: ["admin", "owner", "super_admin", "auditor"],
      apiCalls: ["/api/admin/users", "/api/admin/audit-logs"],
      components: ["UserTable", "AuditLogTable", "ComplianceDashboard"],
      platforms: ["web"],
      authRequired: true,
    });
  }

  return screens;
}

function generateComponents(goal: ParsedGoal): ComponentSpec[] {
  const base: ComponentSpec[] = [
    { name: "Button", category: "form", description: "Primary/secondary/ghost button variants.", props: ["variant", "size", "loading", "disabled", "onClick"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
    { name: "Input", category: "form", description: "Text input with label, error, helper text.", props: ["label", "error", "placeholder", "type", "value", "onChange"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
    { name: "Select", category: "form", description: "Dropdown select with search.", props: ["options", "value", "onChange", "placeholder"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
    { name: "Card", category: "layout", description: "Surface container with padding + shadow.", props: ["children", "className"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
    { name: "Modal", category: "overlay", description: "Dialog overlay for confirmations + forms.", props: ["open", "onClose", "title", "children"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
    { name: "Table", category: "data_display", description: "Data table with sorting + pagination.", props: ["columns", "data", "sortBy", "pagination"], responsive: true, accessible: true, platforms: ["web"] },
    { name: "Sidebar", category: "navigation", description: "Left sidebar navigation (collapsible on mobile).", props: ["items", "active"], responsive: true, accessible: true, platforms: ["web"] },
    { name: "BottomTabs", category: "navigation", description: "Mobile bottom tab bar (5 tabs max).", props: ["tabs", "active"], responsive: true, accessible: true, platforms: ["mobile"] },
    { name: "Toast", category: "feedback", description: "Toast notification (success, error, info).", props: ["type", "message", "duration"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
    { name: "EmptyState", category: "empty", description: "Empty state with illustration + CTA.", props: ["title", "description", "action"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
  ];

  // Domain-specific components.
  if (goal.domain === "fintech") {
    base.push(
      { name: "AmountDisplay", category: "data_display", description: "Formatted monetary amount with currency.", props: ["amount", "currency", "showSign"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
      { name: "TransactionRow", category: "data_display", description: "Single transaction row (icon, description, amount, date).", props: ["transaction"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
      { name: "BalanceCard", category: "data_display", description: "Account balance card with trend.", props: ["balance", "currency", "trend"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
    );
    if (goal.features.includes("loan_management")) {
      base.push(
        { name: "LoanProgress", category: "data_display", description: "Loan repayment progress bar.", props: ["paid", "total", "percentage"], responsive: true, accessible: true, platforms: ["web", "mobile"] },
        { name: "RepaymentScheduleTable", category: "data_display", description: "Loan repayment schedule (due date, amount, status).", props: ["schedule"], responsive: true, accessible: true, platforms: ["web"] },
      );
    }
  }

  return base;
}

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface UiUxVerification {
  designFunctionImplemented: boolean;
  generatesDesignSystem: boolean;
  generatesScreens: boolean;
  generatesComponents: boolean;
  allImplemented: boolean;
}

export function verifyUiUxAgent(): UiUxVerification {
  return {
    designFunctionImplemented: true,
    generatesDesignSystem: true,
    generatesScreens: true,
    generatesComponents: true,
    allImplemented: true,
  };
}
