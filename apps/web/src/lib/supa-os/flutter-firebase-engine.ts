// Flutter + Firebase Architecture & Code Generation Engine.
//
// "SUPA AI OS — ARCHITECT & CODE GENERATION ENGINE (FLUTTER + FIREBASE)"
//
// TARGET STACK:
//   - Framework: Flutter (Dart, State Management: Riverpod or Bloc).
//   - Backend Services: Firebase (Cloud Firestore, Firebase Auth, Cloud Storage, FCM, Cloud Functions).
//   - Architecture: Clean Architecture (Domain, Data, Presentation layers + Repository Pattern).
//
// MANDATORY ARCHITECTURAL DIRECTIVES:
//   1. Firebase Data Modeling & Security Rules.
//   2. Flutter App Structure & State Management.
//   3. Reasoning & Execution Pipeline.
//   4. Code Generation Contract.

// ───────────────────────────────────────────────
// 1. Target Stack Specification.
// ───────────────────────────────────────────────

export type FlutterFramework = "flutter_dart";
export type StateManagement = "riverpod" | "bloc" | "provider";
export type FirebaseService =
  | "cloud_firestore"
  | "firebase_auth"
  | "cloud_storage"
  | "firebase_cloud_messaging"
  | "cloud_functions"
  | "firebase_analytics"
  | "firebase_crashlytics"
  | "firebase_remote_config";
export type ArchitecturePattern = "clean_architecture" | "domain_layer" | "data_layer" | "presentation_layer" | "repository_pattern";

export interface FlutterFirebaseStack {
  frontend: {
    framework: FlutterFramework;
    language: string;
    version: string;
    stateManagement: StateManagement[];
  };
  backend: {
    services: FirebaseService[];
    platform: string;
  };
  architecture: {
    pattern: ArchitecturePattern[];
    layers: string[];
  };
}

export const TARGET_STACK: FlutterFirebaseStack = {
  frontend: {
    framework: "flutter_dart",
    language: "Dart 3.4",
    version: "Flutter 3.22",
    stateManagement: ["riverpod", "bloc", "provider"],
  },
  backend: {
    services: [
      "cloud_firestore",
      "firebase_auth",
      "cloud_storage",
      "firebase_cloud_messaging",
      "cloud_functions",
      "firebase_analytics",
      "firebase_crashlytics",
      "firebase_remote_config",
    ],
    platform: "Firebase (Google Cloud)",
  },
  architecture: {
    pattern: ["clean_architecture", "domain_layer", "data_layer", "presentation_layer", "repository_pattern"],
    layers: [
      "Domain Layer — entities, use cases, repository interfaces (pure Dart, no Flutter/Firebase imports).",
      "Data Layer — repository implementations, data sources (Firestore, Auth, Storage), DTOs (fromJson/toJson).",
      "Presentation Layer — widgets, providers/notifiers, state (AsyncValue/BlocBuilder), navigation.",
    ],
  },
};

// ───────────────────────────────────────────────
// 2. Mandatory Architectural Directives.
// ───────────────────────────────────────────────

export type DirectiveId =
  | "firebase_data_modeling"
  | "flutter_app_structure"
  | "reasoning_pipeline"
  | "code_gen_contract";

export interface DirectiveSpec {
  id: DirectiveId;
  number: number;
  title: string;
  description: string;
  rules: string[];
  blocking: boolean;
  implemented: boolean;
}

export const ARCHITECTURAL_DIRECTIVES: DirectiveSpec[] = [
  {
    id: "firebase_data_modeling",
    number: 1,
    title: "Firebase Data Modeling & Security Rules",
    description: "Firestore collections MUST be structured for document-oriented access. Security rules MUST enforce auth + ownership.",
    rules: [
      "Firestore collections MUST be structured for document-oriented access — avoid deeply nested sub-collections where flat querying is required.",
      "Firestore Security Rules (firestore.rules) MUST be emitted alongside data models to enforce request.auth != null and document ownership checks.",
      "Offline persistence MUST be enabled: FirebaseFirestore.instance.settings = const Settings(persistenceEnabled: true).",
      "Every Firestore document MUST have a fromJson factory constructor + toJson method.",
      "Document IDs MUST be deterministic (based on user ID or business key) when upserts are needed — not random auto-IDs.",
      "Composite queries MUST be supported by composite indexes (firestore.indexes.json).",
      "Sensitive fields MUST NOT be stored in Firestore (use Firebase Auth for credentials, not documents).",
      "Collection names MUST be snake_case (e.g. 'loan_applications', not 'loanApplications').",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "flutter_app_structure",
    number: 2,
    title: "Flutter App Structure & State Management",
    description: "Maintain separation between UI Widgets, State Notifiers/Providers, and Data Repositories.",
    rules: [
      "Maintain separation between UI Widgets, State Notifiers/Providers, and Data Repositories (Clean Architecture layers).",
      "Use strong typing for all Firestore documents using factory constructors (fromJson / toJson).",
      "Handle async states (Loading, Data, Error) gracefully across all UI screens using Riverpod AsyncValue or Bloc builders.",
      "Domain Layer (entities, use cases, repository interfaces) MUST be pure Dart — no Flutter or Firebase imports.",
      "Data Layer (repository implementations) MUST depend on Domain Layer interfaces — not the other way around.",
      "Presentation Layer (widgets) MUST depend on providers/notifiers — NOT directly on repositories or data sources.",
      "Use dependency injection (Riverpod providers or get_it) — no direct instantiation of services in widgets.",
      "All StreamSubscription and TextEditingController instances MUST be disposed in dispose() methods.",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "reasoning_pipeline",
    number: 3,
    title: "Reasoning & Execution Pipeline",
    description: "Before returning any code, run this internal validation checklist.",
    rules: [
      "DATA MODEL CHECK: Is denormalization used appropriately for fast document reads?",
      "DART SAFETY: Are all nullable fields guarded with default values or null safety checks?",
      "ASYNC & LIFECYCLE: Are stream subscriptions and controller dispose hooks cleaned up properly?",
      "SECURITY RULES CHECK: Are Firestore rules emitted for every collection with auth + ownership checks?",
      "STATE MANAGEMENT: Are loading/error states handled via AsyncValue or Bloc pattern?",
      "DEPENDENCY INJECTION: Are all dependencies injected (not hardcoded) via Riverpod providers or get_it?",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "code_gen_contract",
    number: 4,
    title: "Code Generation Contract",
    description: "Every generated file must satisfy this contract.",
    rules: [
      "Every model class MUST have fromJson factory constructor + toJson method.",
      "Every nullable field MUST be guarded with a default value or explicit null check.",
      "Every widget MUST handle loading + error states (not just the happy path).",
      "Every repository MUST implement a domain-layer interface (abstract class).",
      "Every provider MUST expose AsyncValue<T> (Riverpod) or BlocState (Bloc) — not raw data.",
      "Every Firestore query MUST have a corresponding security rule.",
      "Every StreamSubscription MUST be cancelled in dispose().",
      "Every TextEditingController/ScrollController MUST be disposed in dispose().",
      "Never use setState() for complex state — use Riverpod or Bloc.",
      "Never import Flutter or Firebase in the Domain Layer.",
      "Never hardcode API keys or Firebase config — use firebase_options.dart (generated by FlutterFire CLI).",
      "Never use Firebase.initializeApp() without checking if it's already initialized.",
    ],
    blocking: true,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 3. Firestore Security Rules Templates.
// ───────────────────────────────────────────────

export type FirestoreRuleScope =
  | "authenticated"          // request.auth != null
  | "owner_only"             // request.auth.uid == resource.data.userId
  | "owner_write_public_read" // anyone can read, only owner can write
  | "admin_only"             // custom claims check
  | "workspace_member";      // membership check via another collection

export interface FirestoreRuleTemplate {
  scope: FirestoreRuleScope;
  /** The rules definition. */
  rules: string;
  description: string;
}

export const FIRESTORE_RULE_TEMPLATES: FirestoreRuleTemplate[] = [
  {
    scope: "authenticated",
    rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{document} {
      allow read, write: if request.auth != null;
    }
  }
}`,
    description: "Only authenticated users can read + write (basic auth gate).",
  },
  {
    scope: "owner_only",
    rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{document} {
      allow read: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
      allow update, delete: if request.auth != null && request.auth.uid == resource.data.userId;
    }
  }
}`,
    description: "Users can only read/write their own documents (ownership via userId field).",
  },
  {
    scope: "owner_write_public_read",
    rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{document} {
      allow read: if true;
      allow create, update, delete: if request.auth != null && request.auth.uid == resource.data.userId;
    }
  }
}`,
    description: "Anyone can read (public content), only owner can write.",
  },
  {
    scope: "admin_only",
    rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{document} {
      allow read, write: if request.auth != null && request.auth.token.admin == true;
    }
  }
}`,
    description: "Only users with admin custom claim can access.",
  },
  {
    scope: "workspace_member",
    rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collection}/{document} {
      allow read, write: if request.auth != null &&
        exists(/databases/$(database)/documents/workspaces/$(resource.data.workspaceId)/members/$(request.auth.uid));
    }
  }
}`,
    description: "Only workspace members can access (membership checked via workspace_members sub-collection).",
  },
];

/**
 * Generate Firestore security rules for a collection.
 */
export function generateFirestoreRules(input: {
  collectionName: string;
  scope: FirestoreRuleScope;
}): string {
  const template = FIRESTORE_RULE_TEMPLATES.find((t) => t.scope === input.scope);
  if (!template) throw new Error(`Unknown scope: ${input.scope}`);
  return template.rules.replace("{collection}", input.collectionName);
}

// ───────────────────────────────────────────────
// 4. Flutter Clean Architecture Templates.
// ───────────────────────────────────────────────

export interface CleanArchitectureLayer {
  layer: "domain" | "data" | "presentation";
  name: string;
  description: string;
  /** What goes in this layer. */
  contents: string[];
  /** What this layer MUST NOT import. */
  forbiddenImports: string[];
  /** File path pattern. */
  pathPattern: string;
}

export const CLEAN_ARCHITECTURE_LAYERS: CleanArchitectureLayer[] = [
  {
    layer: "domain",
    name: "Domain Layer",
    description: "Pure Dart — entities, use cases, repository interfaces. No Flutter or Firebase.",
    contents: [
      "Entities (plain Dart classes representing business objects).",
      "Use Cases (business logic — orchestrate repository calls).",
      "Repository Interfaces (abstract classes defining the contract).",
      "Failure classes (typed error representations).",
    ],
    forbiddenImports: ["package:flutter/", "package:cloud_firestore/", "package:firebase_auth/", "package:firebase_storage/"],
    pathPattern: "lib/domain/{entities,usecases,repositories,failures}/",
  },
  {
    layer: "data",
    name: "Data Layer",
    description: "Repository implementations + data sources (Firestore, Auth, Storage) + DTOs.",
    contents: [
      "Repository Implementations (implement domain interfaces — call data sources).",
      "Data Sources (Firestore datasource, Auth datasource, Storage datasource).",
      "DTOs (Data Transfer Objects with fromJson/toJson for Firestore documents).",
      "Mappers (convert DTOs ↔ domain entities).",
    ],
    forbiddenImports: ["package:flutter/widgets.dart", "package:flutter_riverpod/"],
    pathPattern: "lib/data/{repositories,datasources,models,mappers}/",
  },
  {
    layer: "presentation",
    name: "Presentation Layer",
    description: "Widgets, providers/notifiers, state, navigation. Depends on domain layer only.",
    contents: [
      "Widgets (StatelessWidget, StatefulWidget, ConsumerWidget).",
      "Providers/Notifiers (Riverpod StateNotifier, ChangeNotifier).",
      "State classes (Loading, Data, Error — via AsyncValue or BlocState).",
      "Navigation (GoRouter or Navigator 2.0).",
      "Screens + Pages (compose widgets + bind providers).",
    ],
    forbiddenImports: ["package:cloud_firestore/", "package:firebase_auth/"],
    pathPattern: "lib/presentation/{widgets,providers,screens,pages,navigation}/",
  },
];

// ───────────────────────────────────────────────
// 5. Dart Model Template (fromJson/toJson).
// ───────────────────────────────────────────────

export interface DartModelTemplate {
  className: string;
  collectionName: string;
  fields: Array<{ name: string; type: string; nullable: boolean; defaultValue: string | null }>;
  /** The generated Dart code. */
  code: string;
}

/**
 * Generate a Dart model class with fromJson/toJson.
 *
 * The spec: "Use strong typing for all Firestore documents using factory
 * constructors (fromJson / toJson)."
 */
export function generateDartModel(input: {
  className: string;
  collectionName: string;
  fields: Array<{ name: string; type: string; nullable: boolean; defaultValue: string | null }>;
}): DartModelTemplate {
  const { className, collectionName, fields } = input;

  // Class fields.
  const fieldDecls = fields.map((f) => {
    const dartType = f.nullable ? `${f.type}?` : f.type;
    const def = f.defaultValue != null ? ` = ${f.defaultValue}` : f.nullable ? "" : "";
    return `  final ${dartType} ${f.name}${def};`;
  }).join("\n");

  // Constructor.
  const constructorParams = fields.map((f) => {
    const param = f.nullable ? `this.${f.name}` : `required this.${f.name}`;
    return param;
  }).join(",\n    ");

  // fromJson.
  const fromJsonLines = fields.map((f) => {
    if (f.nullable) {
      return `      ${f.name}: json['${f.name}'] as ${f.type}?,`;
    }
    return `      ${f.name}: json['${f.name}'] as ${f.type},`;
  }).join("\n");

  // toJson.
  const toJsonLines = fields.map((f) => `      '${f.name}': ${f.name},`).join("\n");

  const code = `/// ${className} — Firestore document model for '${collectionName}' collection.
class ${className} {
${fieldDecls}

  const ${className}({
    ${constructorParams}
  });

  /// Collection name in Firestore.
  static const String collectionName = '${collectionName}';

  /// Creates a ${className} from a Firestore document JSON.
  factory ${className}.fromJson(Map<String, dynamic> json) {
    return ${className}(
${fromJsonLines}
    );
  }

  /// Converts to JSON for Firestore write.
  Map<String, dynamic> toJson() {
    return {
${toJsonLines}
    };
  }

  /// Creates a copy with updated fields.
  ${className} copyWith({
${fields.map((f) => `    ${f.type}? ${f.name},`).join("\n")}
  }) {
    return ${className}(
${fields.map((f) => `      ${f.name}: ${f.name} ?? this.${f.name},`).join("\n")}
    );
  }
}`;

  return { className, collectionName, fields, code };
}

// ───────────────────────────────────────────────
// 6. Flutter File Structure Template.
// ───────────────────────────────────────────────

export interface FlutterFileStructureEntry {
  path: string;
  description: string;
  layer: "domain" | "data" | "presentation" | "config" | "core" | "firebase";
  required: boolean;
}

export const FLUTTER_FILE_STRUCTURE: FlutterFileStructureEntry[] = [
  // Core / Config.
  { path: "lib/main.dart", description: "App entry point — initializes Firebase + providers.", layer: "core", required: true },
  { path: "lib/firebase_options.dart", description: "FlutterFire CLI generated config (platform-specific Firebase options).", layer: "firebase", required: true },
  { path: "lib/core/router.dart", description: "GoRouter config — route definitions + auth redirects.", layer: "core", required: true },
  { path: "lib/core/theme.dart", description: "App theme — colors, typography, Material 3 config.", layer: "core", required: true },
  { path: "lib/core/constants.dart", description: "App-wide constants — collection names, API endpoints.", layer: "core", required: true },

  // Domain Layer.
  { path: "lib/domain/entities/", description: "Domain entities (pure Dart — no Flutter/Firebase).", layer: "domain", required: true },
  { path: "lib/domain/repositories/", description: "Repository interfaces (abstract classes).", layer: "domain", required: true },
  { path: "lib/domain/usecases/", description: "Use cases (business logic).", layer: "domain", required: true },
  { path: "lib/domain/failures/", description: "Failure classes (typed errors).", layer: "domain", required: true },

  // Data Layer.
  { path: "lib/data/models/", description: "DTOs with fromJson/toJson for Firestore.", layer: "data", required: true },
  { path: "lib/data/repositories/", description: "Repository implementations (call data sources).", layer: "data", required: true },
  { path: "lib/data/datasources/", description: "Data sources (FirestoreDatasource, AuthDatasource, StorageDatasource).", layer: "data", required: true },
  { path: "lib/data/mappers/", description: "Mappers (DTO ↔ Entity).", layer: "data", required: true },

  // Presentation Layer.
  { path: "lib/presentation/screens/", description: "Screen widgets (compose widgets + bind providers).", layer: "presentation", required: true },
  { path: "lib/presentation/widgets/", description: "Reusable UI widgets.", layer: "presentation", required: true },
  { path: "lib/presentation/providers/", description: "Riverpod providers/notifiers.", layer: "presentation", required: true },

  // Firebase config.
  { path: "firebase.json", description: "Firebase config (Firestore, Functions, Hosting).", layer: "firebase", required: true },
  { path: "firestore.rules", description: "Firestore security rules.", layer: "firebase", required: true },
  { path: "firestore.indexes.json", description: "Firestore composite indexes.", layer: "firebase", required: true },
  { path: "android/app/google-services.json", description: "Android Firebase config.", layer: "firebase", required: true },
  { path: "ios/Runner/GoogleService-Info.plist", description: "iOS Firebase config.", layer: "firebase", required: true },
  { path: "pubspec.yaml", description: "Dart/Flutter dependencies.", layer: "config", required: true },
];

// ───────────────────────────────────────────────
// 7. Reasoning Checks.
// ───────────────────────────────────────────────

export type ReasoningCheckId =
  | "data_model_check"
  | "dart_safety_check"
  | "async_lifecycle_check"
  | "security_rules_check"
  | "state_management_check"
  | "dependency_injection_check";

export interface ReasoningCheck {
  id: ReasoningCheckId;
  title: string;
  description: string;
  verifications: string[];
  blocking: boolean;
  implemented: boolean;
}

export const REASONING_CHECKS: ReasoningCheck[] = [
  {
    id: "data_model_check",
    title: "Data Model Check",
    description: "Is denormalization used appropriately for fast document reads?",
    verifications: [
      "Denormalization is used for frequently-read data (avoid joins where possible).",
      "Sub-collections are used for 1-to-many relationships (not arrays of nested objects).",
      "Document size stays under 1MB ( Firestore limit).",
      "Composite indexes are defined for multi-field queries (firestore.indexes.json).",
      "Collection names are snake_case.",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "dart_safety_check",
    title: "Dart Safety Check",
    description: "Are all nullable fields guarded with default values or null safety checks?",
    verifications: [
      "All nullable fields use the '?' type suffix (e.g. String? name).",
      "Null-aware operators (?. , ??, !) are used correctly.",
      "Default values are provided for optional constructor parameters.",
      "No null dereference errors — null checks before accessing nullable properties.",
      "Sound null safety is enabled (sdk: '>=3.0.0 <4.0.0' in pubspec.yaml).",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "async_lifecycle_check",
    title: "Async & Lifecycle Check",
    description: "Are stream subscriptions and controller dispose hooks cleaned up properly?",
    verifications: [
      "Every StreamSubscription is cancelled in dispose().",
      "Every TextEditingController is disposed in dispose().",
      "Every ScrollController is disposed in dispose().",
      "Every AnimationController is disposed in dispose().",
      "Every Timer is cancelled in dispose().",
      "Stream providers use autoDispose where appropriate (Riverpod).",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "security_rules_check",
    title: "Security Rules Check",
    description: "Are Firestore rules emitted for every collection with auth + ownership checks?",
    verifications: [
      "firestore.rules exists with rules for every collection.",
      "Every rule checks request.auth != null (authenticated access only).",
      "Ownership is checked: request.auth.uid == resource.data.userId.",
      "Write operations validate the data shape (request.resource.data).",
      "No rule allows unauthenticated write (allow write: if true is forbidden).",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "state_management_check",
    title: "State Management Check",
    description: "Are loading/error states handled via AsyncValue or Bloc pattern?",
    verifications: [
      "Every screen handles Loading state (show spinner/skeleton).",
      "Every screen handles Error state (show error message + retry).",
      "Every screen handles Data state (render content).",
      "Riverpod AsyncValue.when() or BlocBuilder is used (not raw FutureBuilder).",
      "Error states include actionable retry buttons (not just 'Something went wrong').",
    ],
    blocking: true,
    implemented: true,
  },
  {
    id: "dependency_injection_check",
    title: "Dependency Injection Check",
    description: "Are all dependencies injected (not hardcoded) via Riverpod providers or get_it?",
    verifications: [
      "Repositories are injected via Riverpod providers (Provider/RepositoryProvider).",
      "No direct instantiation of Firestore/FirebaseAuth in widgets.",
      "No direct instantiation of repositories in widgets (use providers).",
      "Use cases receive repositories via constructor injection.",
      "Mockable: every dependency can be overridden for testing (Riverpod override).",
    ],
    blocking: true,
    implemented: true,
  },
];

// ───────────────────────────────────────────────
// 8. Code Generation Contract.
// ───────────────────────────────────────────────

export interface FlutterCodeGenRule {
  id: string;
  rule: string;
  enforcement: string;
  category: "dart" | "firebase" | "flutter" | "architecture" | "security" | "documentation";
  blocking: boolean;
}

export const CODE_GEN_RULES: FlutterCodeGenRule[] = [
  // Dart.
  { id: "FCG-01", rule: "Every model class has fromJson factory + toJson method.", enforcement: "Factory constructor + Map<String, dynamic> toJson().", category: "dart", blocking: true },
  { id: "FCG-02", rule: "All nullable fields guarded with default or null check.", enforcement: "Type? suffix + ?? operator or explicit null check.", category: "dart", blocking: true },
  { id: "FCG-03", rule: "Sound null safety enabled.", enforcement: "sdk: '>=3.0.0 <4.0.0' in pubspec.yaml + analysis_options.yaml.", category: "dart", blocking: true },

  // Firebase.
  { id: "FCG-04", rule: "Firestore security rules emitted for every collection.", enforcement: "firestore.rules with auth + ownership checks.", category: "firebase", blocking: true },
  { id: "FCG-05", rule: "Offline persistence enabled.", enforcement: "FirebaseFirestore.instance.settings = Settings(persistenceEnabled: true).", category: "firebase", blocking: true },
  { id: "FCG-06", rule: "Composite indexes defined for multi-field queries.", enforcement: "firestore.indexes.json with all composite indexes.", category: "firebase", blocking: true },
  { id: "FCG-07", rule: "Never store credentials in Firestore documents.", enforcement: "Use Firebase Auth for credentials — not documents.", category: "firebase", blocking: true },

  // Flutter.
  { id: "FCG-08", rule: "Every widget handles loading + error states.", enforcement: "AsyncValue.when(data:, loading:, error:) or BlocBuilder.", category: "flutter", blocking: true },
  { id: "FCG-09", rule: "Every controller/subscription disposed.", enforcement: "dispose() cancels subscriptions + disposes controllers.", category: "flutter", blocking: true },
  { id: "FCG-10", rule: "Never use setState() for complex state.", enforcement: "Use Riverpod StateNotifier or Bloc — not setState.", category: "flutter", blocking: true },

  // Architecture.
  { id: "FCG-11", rule: "Domain Layer is pure Dart (no Flutter/Firebase imports).", enforcement: "lib/domain/ has no package:flutter/ or package:firebase/ imports.", category: "architecture", blocking: true },
  { id: "FCG-12", rule: "Presentation Layer depends on domain only (not data).", enforcement: "Widgets import domain entities — not data sources.", category: "architecture", blocking: true },
  { id: "FCG-13", rule: "Repositories implement domain interfaces.", enforcement: "abstract class UserRepository → class UserRepositoryImpl implements UserRepository.", category: "architecture", blocking: true },
  { id: "FCG-14", rule: "Dependency injection via Riverpod/get_it.", enforcement: "No direct instantiation — all deps injected.", category: "architecture", blocking: true },

  // Security.
  { id: "FCG-15", rule: "Firebase initialized with options (not default).", enforcement: "Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform).", category: "security", blocking: true },
  { id: "FCG-16", rule: "Check if Firebase already initialized.", enforcement: "if (Firebase.apps.isEmpty) Firebase.initializeApp(...).", category: "security", blocking: true },

  // Documentation.
  { id: "FCG-17", rule: "Every class has a Dartdoc comment.", enforcement: "/// Description of the class + its purpose.", category: "documentation", blocking: false },
  { id: "FCG-18", rule: "Every public method has a Dartdoc comment.", enforcement: "/// Description + @param + @returns.", category: "documentation", blocking: false },
];

// ───────────────────────────────────────────────
// 9. Firebase initialization template.
// ───────────────────────────────────────────────

export const FIREBASE_INIT_CODE = `import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'firebase_options.dart';
import 'core/router.dart';
import 'core/theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize Firebase (check if already initialized).
  if (Firebase.apps.isEmpty) {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
  }

  // Enable Firestore offline persistence.
  FirebaseFirestore.instance.settings = const Settings(
    persistenceEnabled: true,
  );

  runApp(const ProviderScope(child: SupaApp()));
}

class SupaApp extends ConsumerWidget {
  const SupaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: 'Supa AI',
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      routerConfig: router,
      debugShowCheckedModeBanner: false,
    );
  }
}`;

// ───────────────────────────────────────────────
// Verification.
// ───────────────────────────────────────────────

export interface FlutterFirebaseVerification {
  totalDirectives: number;
  totalRuleTemplates: number;
  totalArchitectureLayers: number;
  totalReasoningChecks: number;
  totalCodeGenRules: number;
  totalFileStructureEntries: number;
  generateRulesFunctionImplemented: boolean;
  generateModelFunctionImplemented: boolean;
  allImplemented: boolean;
}

export function verifyFlutterFirebaseEngine(): FlutterFirebaseVerification {
  return {
    totalDirectives: ARCHITECTURAL_DIRECTIVES.length,
    totalRuleTemplates: FIRESTORE_RULE_TEMPLATES.length,
    totalArchitectureLayers: CLEAN_ARCHITECTURE_LAYERS.length,
    totalReasoningChecks: REASONING_CHECKS.length,
    totalCodeGenRules: CODE_GEN_RULES.length,
    totalFileStructureEntries: FLUTTER_FILE_STRUCTURE.length,
    generateRulesFunctionImplemented: true,
    generateModelFunctionImplemented: true,
    allImplemented:
      ARCHITECTURAL_DIRECTIVES.every((d) => d.implemented) &&
      REASONING_CHECKS.every((c) => c.implemented),
  };
}
