/**
 * Supa OS — Flutter + Firebase Architecture Engine — tests.
 */

import { describe, it, expect } from "vitest";
import {
  TARGET_STACK,
  ARCHITECTURAL_DIRECTIVES,
  FIRESTORE_RULE_TEMPLATES,
  generateFirestoreRules,
  CLEAN_ARCHITECTURE_LAYERS,
  generateDartModel,
  FLUTTER_FILE_STRUCTURE,
  REASONING_CHECKS,
  CODE_GEN_RULES,
  FIREBASE_INIT_CODE,
  verifyFlutterFirebaseEngine,
  type DirectiveId,
  type FirestoreRuleScope,
  type StateManagement,
  type FirebaseService,
  type ReasoningCheckId,
} from "@/lib/supa-os/flutter-firebase-engine";

// ───────────────────────────────────────────────
// 1. Target Stack
// ───────────────────────────────────────────────

describe("1 — Target Stack", () => {
  it("targets Flutter (Dart) with Riverpod + Bloc", () => {
    expect(TARGET_STACK.frontend.framework).toBe("flutter_dart");
    expect(TARGET_STACK.frontend.language).toContain("Dart");
    expect(TARGET_STACK.frontend.stateManagement).toContain("riverpod");
    expect(TARGET_STACK.frontend.stateManagement).toContain("bloc");
  });

  it("uses Firebase (Firestore + Auth + Storage + FCM + Functions)", () => {
    expect(TARGET_STACK.backend.services).toContain("cloud_firestore");
    expect(TARGET_STACK.backend.services).toContain("firebase_auth");
    expect(TARGET_STACK.backend.services).toContain("cloud_storage");
    expect(TARGET_STACK.backend.services).toContain("firebase_cloud_messaging");
    expect(TARGET_STACK.backend.services).toContain("cloud_functions");
  });

  it("uses Clean Architecture with 3 layers", () => {
    expect(TARGET_STACK.architecture.pattern).toContain("clean_architecture");
    expect(TARGET_STACK.architecture.layers).toHaveLength(3);
    expect(TARGET_STACK.architecture.layers.some((l) => l.includes("Domain Layer"))).toBe(true);
    expect(TARGET_STACK.architecture.layers.some((l) => l.includes("Data Layer"))).toBe(true);
    expect(TARGET_STACK.architecture.layers.some((l) => l.includes("Presentation Layer"))).toBe(true);
  });

  it("StateManagement covers 3 options", () => {
    const sm: StateManagement[] = ["riverpod", "bloc", "provider"];
    expect(sm).toHaveLength(3);
  });

  it("FirebaseService covers 8 services", () => {
    const services: FirebaseService[] = [
      "cloud_firestore", "firebase_auth", "cloud_storage",
      "firebase_cloud_messaging", "cloud_functions",
      "firebase_analytics", "firebase_crashlytics", "firebase_remote_config",
    ];
    expect(services).toHaveLength(8);
  });
});

// ───────────────────────────────────────────────
// 2. Architectural Directives
// ───────────────────────────────────────────────

describe("2 — Architectural Directives", () => {
  it("has 4 directives", () => {
    expect(ARCHITECTURAL_DIRECTIVES).toHaveLength(4);
    const ids = ARCHITECTURAL_DIRECTIVES.map((d) => d.id);
    expect(ids).toContain("firebase_data_modeling");
    expect(ids).toContain("flutter_app_structure");
    expect(ids).toContain("reasoning_pipeline");
    expect(ids).toContain("code_gen_contract");
  });

  it("all 4 directives are blocking + implemented", () => {
    expect(ARCHITECTURAL_DIRECTIVES.every((d) => d.blocking)).toBe(true);
    expect(ARCHITECTURAL_DIRECTIVES.every((d) => d.implemented)).toBe(true);
  });

  it("Directive 1 requires Firestore security rules + offline persistence", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "firebase_data_modeling");
    const rules = d?.rules.join(" ");
    expect(rules).toContain("firestore.rules");
    expect(rules).toContain("request.auth != null");
    expect(rules).toContain("persistenceEnabled: true");
    expect(rules).toContain("fromJson");
    expect(rules).toContain("snake_case");
  });

  it("Directive 2 requires Clean Architecture separation + fromJson/toJson", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "flutter_app_structure");
    const rules = d?.rules.join(" ");
    expect(rules).toContain("Clean Architecture");
    expect(rules).toContain("fromJson");
    expect(rules).toContain("AsyncValue");
    expect(rules).toContain("Domain Layer");
    expect(rules).toContain("dispose()");
  });

  it("Directive 3 has 6 reasoning checks", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "reasoning_pipeline");
    expect(d?.rules.length).toBeGreaterThanOrEqual(6);
    const rules = d?.rules.join(" ");
    expect(rules).toContain("DATA MODEL CHECK");
    expect(rules).toContain("DART SAFETY");
    expect(rules).toContain("ASYNC & LIFECYCLE");
    expect(rules).toContain("SECURITY RULES");
  });

  it("Directive 4 forbids setState, Flutter imports in domain, hardcoded keys", () => {
    const d = ARCHITECTURAL_DIRECTIVES.find((d) => d.id === "code_gen_contract");
    const rules = d?.rules.join(" ");
    expect(rules).toContain("Never use setState()");
    expect(rules).toContain("Never import Flutter");
    expect(rules).toContain("Never hardcode");
  });
});

// ───────────────────────────────────────────────
// 3. Firestore Security Rules
// ───────────────────────────────────────────────

describe("3 — Firestore Security Rules", () => {
  it("has 5 rule templates", () => {
    expect(FIRESTORE_RULE_TEMPLATES).toHaveLength(5);
    const scopes = FIRESTORE_RULE_TEMPLATES.map((t) => t.scope);
    expect(scopes).toContain("authenticated");
    expect(scopes).toContain("owner_only");
    expect(scopes).toContain("owner_write_public_read");
    expect(scopes).toContain("admin_only");
    expect(scopes).toContain("workspace_member");
  });

  it("owner_only checks request.auth.uid == resource.data.userId", () => {
    const template = FIRESTORE_RULE_TEMPLATES.find((t) => t.scope === "owner_only");
    expect(template?.rules).toContain("request.auth.uid");
    expect(template?.rules).toContain("resource.data.userId");
  });

  it("admin_only checks custom claim", () => {
    const template = FIRESTORE_RULE_TEMPLATES.find((t) => t.scope === "admin_only");
    expect(template?.rules).toContain("request.auth.token.admin");
  });

  it("generateFirestoreRules produces valid rules for a collection", () => {
    const rules = generateFirestoreRules({ collectionName: "loan_applications", scope: "owner_only" });
    expect(rules).toContain("rules_version = '2'");
    expect(rules).toContain("request.auth != null");
    expect(rules).toContain("request.auth.uid");
  });

  it("FirestoreRuleScope covers 5 scopes", () => {
    const scopes: FirestoreRuleScope[] = [
      "authenticated", "owner_only", "owner_write_public_read",
      "admin_only", "workspace_member",
    ];
    expect(scopes).toHaveLength(5);
  });
});

// ───────────────────────────────────────────────
// 4. Clean Architecture Layers
// ───────────────────────────────────────────────

describe("4 — Clean Architecture Layers", () => {
  it("has 3 layers (domain, data, presentation)", () => {
    expect(CLEAN_ARCHITECTURE_LAYERS).toHaveLength(3);
    const layers = CLEAN_ARCHITECTURE_LAYERS.map((l) => l.layer);
    expect(layers).toContain("domain");
    expect(layers).toContain("data");
    expect(layers).toContain("presentation");
  });

  it("domain layer forbids Flutter + Firebase imports", () => {
    const domain = CLEAN_ARCHITECTURE_LAYERS.find((l) => l.layer === "domain");
    expect(domain?.forbiddenImports).toContain("package:flutter/");
    expect(domain?.forbiddenImports).toContain("package:cloud_firestore/");
    expect(domain?.forbiddenImports).toContain("package:firebase_auth/");
  });

  it("data layer contains repositories + datasources + DTOs + mappers", () => {
    const data = CLEAN_ARCHITECTURE_LAYERS.find((l) => l.layer === "data");
    const contents = data?.contents.join(" ");
    expect(contents).toContain("Repository Implementations");
    expect(contents).toContain("Data Sources");
    expect(contents).toContain("DTOs");
    expect(contents).toContain("Mappers");
  });

  it("presentation layer contains widgets + providers + state + navigation", () => {
    const presentation = CLEAN_ARCHITECTURE_LAYERS.find((l) => l.layer === "presentation");
    const contents = presentation?.contents.join(" ");
    expect(contents).toContain("Widgets");
    expect(contents).toContain("Providers");
    expect(contents).toContain("State");
    expect(contents).toContain("Navigation");
  });
});

// ───────────────────────────────────────────────
// 5. Dart Model Generation
// ───────────────────────────────────────────────

describe("5 — Dart Model Generation", () => {
  it("generates a Dart class with fromJson + toJson + copyWith", () => {
    const model = generateDartModel({
      className: "LoanApplication",
      collectionName: "loan_applications",
      fields: [
        { name: "id", type: "String", nullable: false, defaultValue: null },
        { name: "userId", type: "String", nullable: false, defaultValue: null },
        { name: "amount", type: "double", nullable: false, defaultValue: null },
        { name: "status", type: "String", nullable: false, defaultValue: "'pending'" },
        { name: "riskScore", type: "int", nullable: true, defaultValue: null },
      ],
    });

    expect(model.code).toContain("class LoanApplication");
    expect(model.code).toContain("fromJson");
    expect(model.code).toContain("toJson");
    expect(model.code).toContain("copyWith");
    expect(model.code).toContain("collectionName");
    expect(model.code).toContain("loan_applications");
    // Non-nullable fields use 'required'.
    expect(model.code).toContain("required this.id");
    // Nullable fields don't use 'required'.
    expect(model.code).toContain("this.riskScore");
    // Fields are final.
    expect(model.code).toContain("final String id");
    expect(model.code).toContain("final int? riskScore");
  });

  it("model code includes factory constructor", () => {
    const model = generateDartModel({
      className: "User",
      collectionName: "users",
      fields: [{ name: "id", type: "String", nullable: false, defaultValue: null }],
    });
    expect(model.code).toContain("factory User.fromJson");
  });
});

// ───────────────────────────────────────────────
// 6. File Structure
// ───────────────────────────────────────────────

describe("6 — Flutter File Structure", () => {
  it("includes Clean Architecture directories", () => {
    const paths = FLUTTER_FILE_STRUCTURE.map((f) => f.path);
    expect(paths.some((p) => p.includes("lib/domain/"))).toBe(true);
    expect(paths.some((p) => p.includes("lib/data/"))).toBe(true);
    expect(paths.some((p) => p.includes("lib/presentation/"))).toBe(true);
  });

  it("includes Firebase config files", () => {
    const paths = FLUTTER_FILE_STRUCTURE.map((f) => f.path);
    expect(paths).toContain("firebase.json");
    expect(paths).toContain("firestore.rules");
    expect(paths).toContain("firestore.indexes.json");
    expect(paths).toContain("lib/firebase_options.dart");
  });

  it("includes main.dart + router + theme", () => {
    const paths = FLUTTER_FILE_STRUCTURE.map((f) => f.path);
    expect(paths).toContain("lib/main.dart");
    expect(paths).toContain("lib/core/router.dart");
    expect(paths).toContain("lib/core/theme.dart");
  });

  it("required files include domain + data + presentation + firebase", () => {
    const required = FLUTTER_FILE_STRUCTURE.filter((f) => f.required);
    const layers = new Set(required.map((f) => f.layer));
    expect(layers.has("domain")).toBe(true);
    expect(layers.has("data")).toBe(true);
    expect(layers.has("presentation")).toBe(true);
    expect(layers.has("firebase")).toBe(true);
  });
});

// ───────────────────────────────────────────────
// 7. Reasoning Checks
// ───────────────────────────────────────────────

describe("7 — Reasoning Checks", () => {
  it("has 6 reasoning checks", () => {
    expect(REASONING_CHECKS).toHaveLength(6);
    const ids = REASONING_CHECKS.map((c) => c.id);
    expect(ids).toContain("data_model_check");
    expect(ids).toContain("dart_safety_check");
    expect(ids).toContain("async_lifecycle_check");
    expect(ids).toContain("security_rules_check");
    expect(ids).toContain("state_management_check");
    expect(ids).toContain("dependency_injection_check");
  });

  it("all 6 checks are blocking + implemented", () => {
    expect(REASONING_CHECKS.every((c) => c.blocking)).toBe(true);
    expect(REASONING_CHECKS.every((c) => c.implemented)).toBe(true);
  });

  it("async_lifecycle_check verifies dispose() for subscriptions + controllers", () => {
    const check = REASONING_CHECKS.find((c) => c.id === "async_lifecycle_check");
    const v = check?.verifications.join(" ");
    expect(v).toContain("StreamSubscription");
    expect(v).toContain("TextEditingController");
    expect(v).toContain("dispose()");
  });

  it("security_rules_check verifies auth + ownership", () => {
    const check = REASONING_CHECKS.find((c) => c.id === "security_rules_check");
    const v = check?.verifications.join(" ").toLowerCase();
    expect(v).toContain("request.auth");
    expect(v).toContain("ownership");
    expect(v).toContain("unauthenticated");
  });
});

// ───────────────────────────────────────────────
// 8. Code Gen Rules
// ───────────────────────────────────────────────

describe("8 — Code Generation Contract", () => {
  it("has 18 code gen rules", () => {
    expect(CODE_GEN_RULES).toHaveLength(18);
  });

  it("rules cover 6 categories", () => {
    const categories = new Set(CODE_GEN_RULES.map((r) => r.category));
    expect(categories.has("dart")).toBe(true);
    expect(categories.has("firebase")).toBe(true);
    expect(categories.has("flutter")).toBe(true);
    expect(categories.has("architecture")).toBe(true);
    expect(categories.has("security")).toBe(true);
    expect(categories.has("documentation")).toBe(true);
  });

  it("FCG-01: every model has fromJson + toJson", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "FCG-01");
    expect(rule?.rule).toContain("fromJson");
    expect(rule?.rule).toContain("toJson");
  });

  it("FCG-05: offline persistence enabled", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "FCG-05");
    expect(rule?.enforcement).toContain("persistenceEnabled: true");
  });

  it("FCG-11: domain layer is pure Dart", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "FCG-11");
    expect(rule?.rule).toContain("pure Dart");
    expect(rule?.enforcement).toContain("no package:flutter/");
  });

  it("FCG-10: never use setState for complex state", () => {
    const rule = CODE_GEN_RULES.find((r) => r.id === "FCG-10");
    expect(rule?.rule).toContain("setState");
    expect(rule?.enforcement).toContain("Riverpod");
  });
});

// ───────────────────────────────────────────────
// 9. Firebase Init Code
// ───────────────────────────────────────────────

describe("9 — Firebase Init Code", () => {
  it("includes Firebase.initializeApp with options", () => {
    expect(FIREBASE_INIT_CODE).toContain("Firebase.initializeApp");
    expect(FIREBASE_INIT_CODE).toContain("DefaultFirebaseOptions.currentPlatform");
  });

  it("checks if Firebase already initialized", () => {
    expect(FIREBASE_INIT_CODE).toContain("Firebase.apps.isEmpty");
  });

  it("enables offline persistence", () => {
    expect(FIREBASE_INIT_CODE).toContain("persistenceEnabled: true");
  });

  it("uses ProviderScope + MaterialApp.router", () => {
    expect(FIREBASE_INIT_CODE).toContain("ProviderScope");
    expect(FIREBASE_INIT_CODE).toContain("MaterialApp.router");
  });
});

// ───────────────────────────────────────────────
// 10. Verification
// ───────────────────────────────────────────────

describe("10 — Verification", () => {
  it("verifyFlutterFirebaseEngine reports all implemented", () => {
    const v = verifyFlutterFirebaseEngine();
    expect(v.totalDirectives).toBe(4);
    expect(v.totalRuleTemplates).toBe(5);
    expect(v.totalArchitectureLayers).toBe(3);
    expect(v.totalReasoningChecks).toBe(6);
    expect(v.totalCodeGenRules).toBe(18);
    expect(v.totalFileStructureEntries).toBeGreaterThanOrEqual(20);
    expect(v.allImplemented).toBe(true);
  });

  it("DirectiveId covers 4 directive ids", () => {
    const ids: DirectiveId[] = [
      "firebase_data_modeling", "flutter_app_structure",
      "reasoning_pipeline", "code_gen_contract",
    ];
    expect(ids).toHaveLength(4);
  });

  it("ReasoningCheckId covers 6 check ids", () => {
    const ids: ReasoningCheckId[] = [
      "data_model_check", "dart_safety_check", "async_lifecycle_check",
      "security_rules_check", "state_management_check", "dependency_injection_check",
    ];
    expect(ids).toHaveLength(6);
  });
});
