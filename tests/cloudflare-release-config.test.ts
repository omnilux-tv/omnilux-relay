import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type WranglerConfig = {
  name?: string;
  routes?: Array<{ pattern?: string }>;
  vars?: Record<string, string>;
};

const checkoutSha = '93cb6efe18208431cddfb8368fd83d5badbf9bfd';
const setupNodeSha = 'a0853c24544627f65ddf259abe73b1d18a591444';
const uploadArtifactSha = 'ea165f8d65b6e75b540449e92b4886f43607fa02';

const read = (path: string): string => readFileSync(path, 'utf8');
const config = (path: string): WranglerConfig => JSON.parse(read(path)) as WranglerConfig;
const routePatterns = (path: string): string[] =>
  (config(path).routes ?? []).flatMap((route) => route.pattern ? [route.pattern] : []);

test('relay Worker release configs keep production routing isolated to the protected production config', () => {
  assert.deepEqual(routePatterns('wrangler.jsonc'), []);
  assert.deepEqual(routePatterns('wrangler.staging.jsonc'), ['relay-test.omnilux.tv/*']);
  assert.deepEqual(routePatterns('wrangler.production.jsonc'), ['relay.omnilux.tv/*']);
  assert.equal(
    config('wrangler.staging.jsonc').vars?.RELAY_CONTROL_URL,
    'https://api-test.omnilux.tv/functions/v1',
  );
  assert.equal(
    config('wrangler.staging.jsonc').vars?.RELAY_GRANT_AUDIENCE,
    'relay-test.omnilux.tv',
  );

  const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  assert.deepEqual(
    Object.entries(packageJson.scripts ?? {}).filter(([name, command]) =>
      name.startsWith('deploy:') || /wrangler deploy(?![^\n]*--dry-run)/.test(command)
    ),
    [],
  );

  const validate = read('.github/workflows/cloudflare-worker-validate.yml');
  assert.match(validate, /pull_request:/);
  assert.match(validate, /push:/);
  assert.doesNotMatch(validate, /wrangler deploy(?![^\n]*--dry-run)/);
  assert.match(validate, /repository: omnilux-tv\/omnilux-packages\n\s+ref: [0-9a-f]{40}/);

  const staging = read('.github/workflows/cloudflare-worker-staging.yml');
  assert.match(staging, /workflow_dispatch:/);
  assert.doesNotMatch(staging, /\n\s+push:/);
  assert.match(staging, /environment:\s*relay-staging/);
  assert.match(staging, /wrangler\.staging\.jsonc/);
  assert.match(staging, /wrangler deployments list/);
  assert.match(staging, /wrangler versions list/);
  assert.match(staging, /verify-worker-deployment-evidence\.mjs/);
  assert.match(staging, /https:\/\/relay-test\.omnilux\.tv\/readyz/);
  assert.match(staging, /repository: omnilux-tv\/omnilux-packages\n\s+ref: [0-9a-f]{40}/);

  const production = read('.github/workflows/cloudflare-worker-production.yml');
  assert.match(production, /workflow_dispatch:/);
  assert.doesNotMatch(production, /\n\s+push:/);
  assert.match(production, /environment:\s*relay-production/);
  assert.match(production, /release_sha:/);
  assert.match(production, /staging_version_id:/);
  assert.match(production, /rollback_version_id:/);
  assert.match(production, /worker-staging-deployments-before\.json/);
  assert.match(production, /wrangler deployments list/);
  assert.match(production, /wrangler versions list/);
  assert.match(production, /verify-worker-deployment-evidence\.mjs/);
  assert.doesNotMatch(production, /grep -F/);
  assert.match(production, /wrangler\.production\.jsonc/);
  assert.match(production, /repository: omnilux-tv\/omnilux-packages\n\s+ref: [0-9a-f]{40}/);

  for (const workflow of [validate, staging, production]) {
    assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node|upload-artifact)@v\d/);
    assert.match(workflow, new RegExp(`actions/checkout@${checkoutSha}`));
    assert.match(workflow, new RegExp(`actions/setup-node@${setupNodeSha}`));
  }
  assert.match(staging, new RegExp(`actions/upload-artifact@${uploadArtifactSha}`));
  assert.match(production, new RegExp(`actions/upload-artifact@${uploadArtifactSha}`));
});
