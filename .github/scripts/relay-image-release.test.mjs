import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  validateRelayImageAttestations,
  validateRelayImageMetadata,
} from '../../scripts/verify-relay-image-release.mjs';

const workflow = readFileSync(new URL('../workflows/docker-publish.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const revision = '1'.repeat(40);
const packagesRevision = '2'.repeat(40);
const digest = `sha256:${'3'.repeat(64)}`;
const version = `0.1.0+sha.${revision}`;

const slsaV1 = {
  buildDefinition: {
    buildType: 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
    externalParameters: { request: {} },
    internalParameters: { github_repository: 'omnilux-tv/omnilux-relay' },
    resolvedDependencies: [],
  },
  runDetails: {
    builder: { id: 'https://github.com/docker/buildx/actions/runs/1/attempts/1' },
    metadata: {
      buildkit_completeness: { request: true, resolvedDependencies: false },
    },
  },
};

const spdx = {
  SPDXID: 'SPDXRef-DOCUMENT',
  spdxVersion: 'SPDX-2.3',
  packages: [{ name: 'omnilux-relay' }],
};

describe('relay image release evidence', () => {
  it('accepts current BuildKit max provenance and a populated SPDX SBOM', () => {
    const result = validateRelayImageAttestations({
      manifest: {
        manifests: [
          { platform: { os: 'linux', architecture: 'amd64' } },
          { platform: { os: 'unknown', architecture: 'unknown' } },
        ],
      },
      provenance: { 'linux/amd64': { SLSA: slsaV1 } },
      sbom: { 'linux/amd64': { SPDX: spdx } },
      expectedPlatforms: ['linux/amd64'],
    });

    assert.deepEqual(result.platforms, ['linux/amd64']);
    assert.equal(result.provenanceStatements, 1);
    assert.equal(result.spdxDocuments, 1);
  });

  it('rejects evidence not bound to the offered platform', () => {
    assert.throws(
      () =>
        validateRelayImageAttestations({
          manifest: { manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] },
          provenance: { duplicate: { SLSA: slsaV1 } },
          sbom: { duplicate: { SPDX: spdx } },
          expectedPlatforms: ['linux/amd64'],
        }),
      /provenance is not bound.*SBOM is not bound/s,
    );
  });

  it('rejects incomplete provenance and empty SBOM documents', () => {
    assert.throws(
      () =>
        validateRelayImageAttestations({
          manifest: { manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] },
          provenance: {
            'linux/amd64': {
              SLSA: {
                ...slsaV1,
                buildDefinition: { ...slsaV1.buildDefinition, internalParameters: {} },
              },
            },
          },
          sbom: { 'linux/amd64': { SPDX: { ...spdx, packages: [] } } },
          expectedPlatforms: ['linux/amd64'],
        }),
      /not complete mode=max provenance.*has no packages/s,
    );
  });

  it('binds the pulled image to the exact digest and immutable labels', () => {
    const exactRef = `ghcr.io/omnilux-tv/omnilux-relay-runtime@${digest}`;
    const result = validateRelayImageMetadata({
      imageInspect: [
        {
          RepoDigests: [exactRef],
          Config: {
            Labels: {
              'org.opencontainers.image.revision': revision,
              'org.opencontainers.image.version': version,
              'tv.omnilux.omnilux-packages.revision': packagesRevision,
            },
          },
        },
      ],
      expectedDigest: digest,
      expectedImageRef: exactRef,
      expectedRepository: 'ghcr.io/omnilux-tv/omnilux-relay-runtime',
      expectedRevision: revision,
      expectedVersion: version,
      expectedPackagesRevision: packagesRevision,
    });

    assert.equal(result.digest, digest);
    assert.equal(result.revision, revision);
    assert.equal(result.omniluxPackagesRevision, packagesRevision);
  });

  it('rejects label or repository substitution', () => {
    assert.throws(
      () =>
        validateRelayImageMetadata({
          imageInspect: [{ RepoDigests: [`example.invalid/relay@${digest}`], Config: { Labels: {} } }],
          expectedDigest: digest,
          expectedImageRef: `example.invalid/relay@${digest}`,
          expectedRepository: 'ghcr.io/omnilux-tv/omnilux-relay-runtime',
          expectedRevision: revision,
          expectedVersion: version,
          expectedPackagesRevision: packagesRevision,
        }),
      /label org.opencontainers.image.revision.*expected repository/s,
    );
  });
});

describe('relay image publication workflow', () => {
  it('labels the image with immutable relay and omnilux-packages revisions', () => {
    const baseDigest = 'sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf';
    assert.equal((dockerfile.match(new RegExp(`^FROM node:22-bookworm-slim@${baseDigest}`, 'gm')) ?? []).length, 2);
    assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.base\\.digest="${baseDigest}"`));
    assert.match(dockerfile, /^ARG RELAY_VERSION=0\.1\.0$/m);
    assert.match(dockerfile, /^ARG RELAY_REVISION=unknown$/m);
    assert.match(dockerfile, /^ARG OMNILUX_PACKAGES_REVISION=unknown$/m);
    assert.match(dockerfile, /org\.opencontainers\.image\.version="\$\{RELAY_VERSION\}"/);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{RELAY_REVISION\}"/);
    assert.match(dockerfile, /tv\.omnilux\.omnilux-packages\.revision="\$\{OMNILUX_PACKAGES_REVISION\}"/);
    assert.match(workflow, /ref: 4417465ef7068f0a4576f7028d277e5367388992/);
    assert.match(workflow, /OMNILUX_PACKAGES_REVISION=\$\{\{ steps\.release\.outputs\.packages_revision \}\}/);
  });

  it('builds once into an ephemeral local registry with max provenance and an SPDX SBOM', () => {
    assert.equal((workflow.match(/uses: docker\/build-push-action@/g) ?? []).length, 1);
    assert.doesNotMatch(workflow, /uses: [^\n]+@v\d+/);
    assert.match(workflow, /LOCAL_CANDIDATE_IMAGE: localhost:5000\/omnilux-relay-runtime-candidate/);
    assert.match(workflow, /image: registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373/);
    assert.match(workflow, /driver-opts: network=host/);
    assert.match(workflow, /outputs: type=image,name=\$\{\{ env\.LOCAL_CANDIDATE_IMAGE \}\},push-by-digest=true,name-canonical=true,push=true,registry\.insecure=true/);
    assert.match(workflow, /provenance: mode=max/);
    assert.match(workflow, /sbom: true/);
    assert.doesNotMatch(workflow, /load: true/);
    assert.doesNotMatch(workflow, /type=sha,prefix=sha-,format=short/);
  });

  it('validates main-bound source and boots the exact candidate before registry authentication', () => {
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /git merge-base --is-ancestor "\$revision" origin\/main/);
    assert.match(workflow, /pnpm lint && pnpm lint:worker && pnpm test:release-config && pnpm test:smoke && pnpm build/);
    assert.match(workflow, /RELAY_CONTROL_URL=http:\/\/127\.0\.0\.1:9\/functions\/v1/);
    assert.match(workflow, /fetch\('http:\/\/127\.0\.0\.1:8090\/healthz'\)/);
    const sourceValidationIndex = workflow.indexOf('- name: Validate relay source');
    const buildIndex = workflow.indexOf('- name: Build candidate into ephemeral registry');
    const bootIndex = workflow.indexOf('- name: Pull and execute exact local candidate');
    const loginIndex = workflow.indexOf('- name: Log in to GitHub Container Registry after candidate verification');
    assert.ok(sourceValidationIndex >= 0 && sourceValidationIndex < buildIndex);
    assert.ok(buildIndex < bootIndex && bootIndex < loginIndex);
  });

  it('fails closed behind the protected production environment and an explicit repository variable', () => {
    assert.doesNotMatch(workflow, /branches:/);
    assert.doesNotMatch(workflow, /RELAY_IMAGE}:latest|RELAY_IMAGE\}:latest/);
    assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+release_sha:/);
    assert.match(workflow, /if: \$\{\{ vars\.RELAY_IMAGE_RELEASE_ENABLED == 'true' \}\}/);
    assert.match(workflow, /environment:\n\s+name: relay-production/);
    assert.match(workflow, /Confirm protected production release gate/);
    assert.match(workflow, /concurrency:\n\s+group: relay-image-production\n\s+cancel-in-progress: false/);
  });

  it('verifies the local digest before registry login and promotes without rebuilding', () => {
    const buildIndex = workflow.indexOf('- name: Build candidate into ephemeral registry');
    const verifyIndex = workflow.indexOf('- name: Verify local candidate attestations and labels');
    const loginIndex = workflow.indexOf('- name: Log in to GitHub Container Registry after candidate verification');
    const promoteIndex = workflow.indexOf('- name: Promote exact verified digest without rebuild');
    assert.ok(buildIndex >= 0 && buildIndex < verifyIndex && verifyIndex < loginIndex && loginIndex < promoteIndex);
    assert.match(workflow, /docker pull "\$exact_ref"/);
    assert.match(workflow, /verify-relay-image-release\.mjs/);
    assert.match(workflow, /--format '\{\{json \.Provenance\}\}'/);
    assert.match(workflow, /--format '\{\{json \.SBOM\}\}'/);
    assert.match(workflow, /skopeo copy \\\n\s+--all \\\n\s+--preserve-digests/);
    assert.match(workflow, /--dest-authfile "\$HOME\/\.docker\/config\.json"/);
    assert.match(workflow, /docker buildx imagetools create --prefer-index=false "\$\{promotion_args\[@\]\}" "\$seed_tag"/);
    assert.match(workflow, /test "\$actual_digest" = "\$expected_digest"/);
    assert.match(workflow, /sha-\$\{\{ steps\.release\.outputs\.revision \}\}/);
    assert.match(workflow, /Verify promoted digest and copied attestations/);
  });
});
