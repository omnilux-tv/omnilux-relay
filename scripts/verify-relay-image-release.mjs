import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LABELS = Object.freeze({
  revision: 'org.opencontainers.image.revision',
  version: 'org.opencontainers.image.version',
  packagesRevision: 'tv.omnilux.omnilux-packages.revision',
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectObjectsWithKey(value, key, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (!Array.isArray(value) && isObject(value[key])) output.push(value[key]);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectObjectsWithKey(child, key, output);
  }
  return output;
}

function imagePlatforms(manifest) {
  const descriptors = Array.isArray(manifest?.manifests) ? manifest.manifests : [];
  return new Set(
    descriptors
      .map((descriptor) => descriptor?.platform)
      .filter((platform) => platform?.os && platform?.architecture)
      .filter((platform) => platform.os !== 'unknown' && platform.architecture !== 'unknown')
      .map((platform) => `${platform.os}/${platform.architecture}`),
  );
}

function isMaxBuildKitProvenance(statement) {
  const isV02 =
    statement.buildType === 'https://mobyproject.org/buildkit@v1' &&
    Array.isArray(statement.materials) &&
    isObject(statement.invocation?.parameters) &&
    isObject(statement.invocation?.environment) &&
    statement.metadata?.completeness?.parameters === true &&
    statement.metadata?.completeness?.environment === true;

  const buildType = statement.buildDefinition?.buildType;
  const internalParameters = statement.buildDefinition?.internalParameters;
  const isV1 =
    typeof buildType === 'string' &&
    buildType.includes('moby/buildkit') &&
    isObject(statement.buildDefinition?.externalParameters) &&
    isObject(internalParameters) &&
    Object.keys(internalParameters).length > 0 &&
    Array.isArray(statement.buildDefinition?.resolvedDependencies) &&
    typeof statement.runDetails?.builder?.id === 'string' &&
    statement.runDetails.builder.id.length > 0 &&
    statement.runDetails?.metadata?.buildkit_completeness?.request === true &&
    typeof statement.runDetails?.metadata?.buildkit_completeness?.resolvedDependencies === 'boolean';

  return isV02 || isV1;
}

export function validateRelayImageAttestations({ manifest, provenance, sbom, expectedPlatforms }) {
  const errors = [];
  const platforms = imagePlatforms(manifest);

  for (const expected of expectedPlatforms) {
    if (!platforms.has(expected)) errors.push(`manifest is missing required platform ${expected}`);
    if (collectObjectsWithKey(provenance?.[expected], 'SLSA').length === 0) {
      errors.push(`provenance is not bound to manifest platform ${expected}`);
    }
    if (collectObjectsWithKey(sbom?.[expected], 'SPDX').length === 0) {
      errors.push(`SBOM is not bound to manifest platform ${expected}`);
    }
  }

  const statements = collectObjectsWithKey(provenance, 'SLSA');
  if (statements.length < expectedPlatforms.length) {
    errors.push(
      `expected at least ${expectedPlatforms.length} provenance statement(s), found ${statements.length}`,
    );
  }
  for (const [index, statement] of statements.entries()) {
    if (!isMaxBuildKitProvenance(statement)) {
      errors.push(`provenance statement ${index + 1} is not complete mode=max provenance`);
    }
  }

  const spdxDocuments = collectObjectsWithKey(sbom, 'SPDX');
  if (spdxDocuments.length < expectedPlatforms.length) {
    errors.push(`expected at least ${expectedPlatforms.length} SPDX document(s), found ${spdxDocuments.length}`);
  }
  for (const [index, document] of spdxDocuments.entries()) {
    if (document.SPDXID !== 'SPDXRef-DOCUMENT') {
      errors.push(`SBOM document ${index + 1} has an invalid SPDX document ID`);
    }
    if (typeof document.spdxVersion !== 'string' || !document.spdxVersion.startsWith('SPDX-')) {
      errors.push(`SBOM document ${index + 1} has an invalid SPDX version`);
    }
    if (!Array.isArray(document.packages) || document.packages.length === 0) {
      errors.push(`SBOM document ${index + 1} has no packages`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`relay image attestation validation failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    platforms: [...platforms].sort(),
    provenanceStatements: statements.length,
    spdxDocuments: spdxDocuments.length,
  };
}

export function validateRelayImageMetadata({
  imageInspect,
  expectedDigest,
  expectedImageRef,
  expectedRepository,
  expectedRevision,
  expectedVersion,
  expectedPackagesRevision,
}) {
  const errors = [];
  const inspected = Array.isArray(imageInspect) ? imageInspect[0] : imageInspect;
  const labels = inspected?.Config?.Labels ?? {};
  const expectedLabels = {
    [LABELS.revision]: expectedRevision,
    [LABELS.version]: expectedVersion,
    [LABELS.packagesRevision]: expectedPackagesRevision,
  };

  for (const [name, expected] of Object.entries(expectedLabels)) {
    if (labels[name] !== expected) {
      errors.push(`label ${name} expected ${expected}, found ${labels[name] ?? '<missing>'}`);
    }
  }

  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) {
    errors.push(`expected digest is not an immutable sha256 digest: ${expectedDigest}`);
  }
  if (expectedImageRef !== `${expectedRepository}@${expectedDigest}`) {
    errors.push(`exact image reference is not bound to the expected repository and digest`);
  }
  const repoDigests = Array.isArray(inspected?.RepoDigests) ? inspected.RepoDigests : [];
  if (!repoDigests.some((value) => value.endsWith(`@${expectedDigest}`))) {
    errors.push(`pulled image metadata is not bound to ${expectedDigest}`);
  }

  if (errors.length > 0) {
    throw new Error(`relay image metadata validation failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    imageRef: expectedImageRef,
    digest: expectedDigest,
    revision: expectedRevision,
    version: expectedVersion,
    omniluxPackagesRevision: expectedPackagesRevision,
  };
}

function parseArguments(argv) {
  const options = { expectedPlatforms: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === '--manifest-file') options.manifestFile = next;
    else if (value === '--provenance-file') options.provenanceFile = next;
    else if (value === '--sbom-file') options.sbomFile = next;
    else if (value === '--image-inspect-file') options.imageInspectFile = next;
    else if (value === '--image-ref') options.imageRef = next;
    else if (value === '--repository') options.repository = next;
    else if (value === '--digest') options.digest = next;
    else if (value === '--revision') options.revision = next;
    else if (value === '--version') options.version = next;
    else if (value === '--packages-revision') options.packagesRevision = next;
    else if (value === '--platform') options.expectedPlatforms.push(next);
    else throw new Error(`unknown argument: ${value}`);
    index += 1;
  }
  for (const name of [
    'manifestFile',
    'provenanceFile',
    'sbomFile',
    'imageInspectFile',
    'imageRef',
    'repository',
    'digest',
    'revision',
    'version',
    'packagesRevision',
  ]) {
    if (!options[name]) {
      const flag = name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
      throw new Error(`missing required --${flag}`);
    }
  }
  if (options.expectedPlatforms.length === 0) throw new Error('missing required --platform');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const attestations = validateRelayImageAttestations({
      manifest: JSON.parse(readFileSync(options.manifestFile, 'utf8')),
      provenance: JSON.parse(readFileSync(options.provenanceFile, 'utf8')),
      sbom: JSON.parse(readFileSync(options.sbomFile, 'utf8')),
      expectedPlatforms: options.expectedPlatforms,
    });
    const metadata = validateRelayImageMetadata({
      imageInspect: JSON.parse(readFileSync(options.imageInspectFile, 'utf8')),
      expectedDigest: options.digest,
      expectedImageRef: options.imageRef,
      expectedRepository: options.repository,
      expectedRevision: options.revision,
      expectedVersion: options.version,
      expectedPackagesRevision: options.packagesRevision,
    });
    process.stdout.write(`${JSON.stringify({ ...metadata, ...attestations }, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
