/**
 * Tests for the CI/CD pipeline generator.
 *
 * Verifies:
 *   1. Each (target × provider) combination produces a GeneratedPipeline
 *      with the right file path + non-empty YAML content.
 *   2. GitHub Actions YAML contains the expected structure (on: push, jobs,
 *      build, deploy, secrets as ${{ secrets.X }}).
 *   3. GitLab CI YAML contains the expected structure (stages, image, rules).
 *   4. CircleCI YAML contains the expected structure (version 2.1, orbs, jobs,
 *      workflows).
 *   5. The requiredSecretsForTarget() helper returns the right env vars.
 *   6. Options (runTests=false, requireManualApproval=true) shape the output.
 */

import { describe, it, expect } from "vitest";
import {
  generatePipeline,
  requiredSecretsForTarget,
  type CiProvider,
} from "@/lib/supa-os/cicd-pipeline-generator";

const TARGETS = ["vercel", "aws", "gcp", "supabase", "self_hosted"] as const;
const PROVIDERS: CiProvider[] = ["github_actions", "gitlab_ci", "circleci"];

const SAMPLE_INPUT = {
  appName: "test-app",
  runTests: true,
  runLint: true,
  requireManualApproval: false,
  requiredSecrets: [],
};

// ───────────────────────────────────────────────
// All (target × provider) combos produce output
// ───────────────────────────────────────────────

describe("generatePipeline — all combinations", () => {
  for (const target of TARGETS) {
    for (const provider of PROVIDERS) {
      it(`${provider} + ${target} produces a GeneratedPipeline`, () => {
        const result = generatePipeline({ ...SAMPLE_INPUT, target, provider });
        expect(result.provider).toBe(provider);
        expect(result.content.length).toBeGreaterThan(100);
        expect(result.content).toContain(target); // target mentioned somewhere
      });
    }
  }
});

// ───────────────────────────────────────────────
// File paths
// ───────────────────────────────────────────────

describe("generatePipeline — file paths", () => {
  it("GitHub Actions writes to .github/workflows/deploy.yml", () => {
    const result = generatePipeline({ ...SAMPLE_INPUT, target: "vercel", provider: "github_actions" });
    expect(result.filePath).toBe(".github/workflows/deploy.yml");
  });

  it("GitLab CI writes to .gitlab-ci.yml", () => {
    const result = generatePipeline({ ...SAMPLE_INPUT, target: "vercel", provider: "gitlab_ci" });
    expect(result.filePath).toBe(".gitlab-ci.yml");
  });

  it("CircleCI writes to .circleci/config.yml", () => {
    const result = generatePipeline({ ...SAMPLE_INPUT, target: "vercel", provider: "circleci" });
    expect(result.filePath).toBe(".circleci/config.yml");
  });
});

// ───────────────────────────────────────────────
// GitHub Actions YAML structure
// ───────────────────────────────────────────────

describe("GitHub Actions YAML structure", () => {
  const yaml = generatePipeline({ ...SAMPLE_INPUT, target: "vercel", provider: "github_actions" }).content;

  it("triggers on push to main", () => {
    expect(yaml).toContain("on:");
    expect(yaml).toContain("push:");
    expect(yaml).toContain("branches: [main]");
  });

  it("has a build job with checkout + setup-node", () => {
    expect(yaml).toContain("jobs:");
    expect(yaml).toContain("build:");
    expect(yaml).toContain("actions/checkout@v4");
    expect(yaml).toContain("actions/setup-node@v4");
  });

  it("runs lint + test + build by default", () => {
    expect(yaml).toContain("name: Lint");
    expect(yaml).toContain("npm run lint");
    expect(yaml).toContain("name: Test");
    expect(yaml).toContain("npm test");
    expect(yaml).toContain("name: Build");
    expect(yaml).toContain("npm run build");
  });

  it("has a deploy job that depends on build", () => {
    expect(yaml).toContain("deploy:");
    expect(yaml).toContain("needs: build");
  });

  it("references secrets via ${{ secrets.X }}", () => {
    const withSecrets = generatePipeline({
      ...SAMPLE_INPUT,
      target: "vercel",
      provider: "github_actions",
      requiredSecrets: ["VERCEL_TOKEN", "VERCEL_ORG_ID"],
    }).content;
    expect(withSecrets).toContain("${{ secrets.VERCEL_TOKEN }}");
    expect(withSecrets).toContain("${{ secrets.VERCEL_ORG_ID }}");
  });

  it("Vercel deploy uses the vercel-action", () => {
    expect(yaml).toContain("amondnet/vercel-action");
  });

  it("AWS deploy uses configure-aws-credentials + ECR + ECS", () => {
    const awsYaml = generatePipeline({ ...SAMPLE_INPUT, target: "aws", provider: "github_actions" }).content;
    expect(awsYaml).toContain("aws-actions/configure-aws-credentials");
    expect(awsYaml).toContain("aws-actions/amazon-ecr-build-and-push");
    expect(awsYaml).toContain("aws ecs update-service");
  });

  it("GCP deploy uses google-github-actions", () => {
    const gcpYaml = generatePipeline({ ...SAMPLE_INPUT, target: "gcp", provider: "github_actions" }).content;
    expect(gcpYaml).toContain("google-github-actions/auth");
    expect(gcpYaml).toContain("google-github-actions/deploy-cloudrun");
  });

  it("Supabase deploy uses supabase CLI for migrations + functions", () => {
    const supaYaml = generatePipeline({ ...SAMPLE_INPUT, target: "supabase", provider: "github_actions" }).content;
    expect(supaYaml).toContain("npm install -g supabase");
    expect(supaYaml).toContain("supabase db push");
    expect(supaYaml).toContain("supabase functions deploy");
  });

  it("Self-hosted deploy uses scp + ssh actions", () => {
    const selfYaml = generatePipeline({ ...SAMPLE_INPUT, target: "self_hosted", provider: "github_actions" }).content;
    expect(selfYaml).toContain("docker build");
    expect(selfYaml).toContain("appleboy/scp-action");
    expect(selfYaml).toContain("appleboy/ssh-action");
  });
});

// ───────────────────────────────────────────────
// GitLab CI YAML structure
// ───────────────────────────────────────────────

describe("GitLab CI YAML structure", () => {
  const yaml = generatePipeline({ ...SAMPLE_INPUT, target: "vercel", provider: "gitlab_ci" }).content;

  it("uses node:20 image", () => {
    expect(yaml).toContain("image: node:20");
  });

  it("has stages test + build + deploy", () => {
    expect(yaml).toContain("stages:");
    expect(yaml).toContain("- test");
    expect(yaml).toContain("- build");
    expect(yaml).toContain("- deploy");
  });

  it("has lint + test jobs by default", () => {
    expect(yaml).toContain("lint:");
    expect(yaml).toContain("npm run lint");
    expect(yaml).toContain("test:");
    expect(yaml).toContain("npm test");
  });

  it("build job persists artifacts", () => {
    expect(yaml).toContain("build:");
    expect(yaml).toContain("artifacts:");
    expect(yaml).toContain("paths:");
  });

  it("deploy job needs build", () => {
    expect(yaml).toContain("deploy:");
    expect(yaml).toContain("needs: [build]");
  });

  it("deploy job uses vercel CLI for vercel target", () => {
    expect(yaml).toContain("vercel --prod --yes");
  });
});

// ───────────────────────────────────────────────
// CircleCI YAML structure
// ───────────────────────────────────────────────

describe("CircleCI YAML structure", () => {
  const yaml = generatePipeline({ ...SAMPLE_INPUT, target: "vercel", provider: "circleci" }).content;

  it("uses version 2.1", () => {
    expect(yaml).toContain("version: 2.1");
  });

  it("declares the node orb", () => {
    expect(yaml).toContain("orbs:");
    expect(yaml).toContain("node: circleci/node@");
  });

  it("has test, build, and deploy jobs", () => {
    expect(yaml).toContain("test:");
    expect(yaml).toContain("build:");
    expect(yaml).toContain("deploy:");
  });

  it("build job persists to workspace", () => {
    expect(yaml).toContain("persist_to_workspace:");
  });

  it("deploy job attaches workspace", () => {
    expect(yaml).toContain("attach_workspace:");
  });

  it("workflow requires build before deploy", () => {
    expect(yaml).toContain("workflows:");
    expect(yaml).toContain("build-and-deploy:");
    expect(yaml).toContain("requires: [build]");
  });
});

// ───────────────────────────────────────────────
// Options — runTests=false, requireManualApproval=true
// ───────────────────────────────────────────────

describe("pipeline options", () => {
  it("omits lint + test steps when runTests=false and runLint=false (GitHub Actions)", () => {
    const yaml = generatePipeline({
      ...SAMPLE_INPUT,
      target: "vercel",
      provider: "github_actions",
      runTests: false,
      runLint: false,
    }).content;
    expect(yaml).not.toContain("name: Lint");
    expect(yaml).not.toContain("name: Test");
  });

  it("adds a staging + production deploy when requireManualApproval=true (GitHub Actions)", () => {
    const yaml = generatePipeline({
      ...SAMPLE_INPUT,
      target: "vercel",
      provider: "github_actions",
      requireManualApproval: true,
    }).content;
    expect(yaml).toContain("deploy-staging:");
    expect(yaml).toContain("deploy-production:");
    expect(yaml).toContain("name: staging");
    expect(yaml).toContain("name: production");
  });

  it("marks the GitLab deploy job as manual when requireManualApproval=true", () => {
    const yaml = generatePipeline({
      ...SAMPLE_INPUT,
      target: "vercel",
      provider: "gitlab_ci",
      requireManualApproval: true,
    }).content;
    expect(yaml).toContain("when: manual");
  });

  it("uses type: approval for CircleCI when requireManualApproval=true", () => {
    const yaml = generatePipeline({
      ...SAMPLE_INPUT,
      target: "vercel",
      provider: "circleci",
      requireManualApproval: true,
    }).content;
    expect(yaml).toContain("type: approval");
  });
});

// ───────────────────────────────────────────────
// requiredSecretsForTarget
// ───────────────────────────────────────────────

describe("requiredSecretsForTarget", () => {
  it("returns VERCEL_TOKEN + VERCEL_ORG_ID + VERCEL_PROJECT_ID for vercel", () => {
    const secrets = requiredSecretsForTarget("vercel");
    expect(secrets).toContain("VERCEL_TOKEN");
    expect(secrets).toContain("VERCEL_ORG_ID");
    expect(secrets).toContain("VERCEL_PROJECT_ID");
  });

  it("returns AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION for aws", () => {
    const secrets = requiredSecretsForTarget("aws");
    expect(secrets).toContain("AWS_ACCESS_KEY_ID");
    expect(secrets).toContain("AWS_SECRET_ACCESS_KEY");
    expect(secrets).toContain("AWS_REGION");
  });

  it("returns GCP_SA_KEY for gcp", () => {
    expect(requiredSecretsForTarget("gcp")).toContain("GCP_SA_KEY");
  });

  it("returns SUPABASE_ACCESS_TOKEN for supabase", () => {
    expect(requiredSecretsForTarget("supabase")).toContain("SUPABASE_ACCESS_TOKEN");
  });

  it("returns DEPLOY_HOST + DEPLOY_USER + DEPLOY_SSH_KEY for self_hosted", () => {
    const secrets = requiredSecretsForTarget("self_hosted");
    expect(secrets).toContain("DEPLOY_HOST");
    expect(secrets).toContain("DEPLOY_USER");
    expect(secrets).toContain("DEPLOY_SSH_KEY");
  });
});
