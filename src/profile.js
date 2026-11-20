/**
 * Validate declarative application profiles before the Worker starts.
 *
 * Unknown fields are rejected deliberately: a typo must never silently widen
 * a public route or disable authentication checks.
 */
import { validateRequestContract } from './request-contract-profile.js';

const PROFILE_FIELDS = [
  'schemaVersion',
  'id',
  'hostname',
  'epoch',
  'routes',
  'credentials',
  'retentionDays',
  'validationTimeoutMs',
];

const ROUTE_FIELDS = ['access', 'methods', 'exact', 'prefix', 'rateLimit', 'request'];
const CREDENTIAL_FIELDS = ['id', 'type', 'name', 'validation'];
const VALIDATION_FIELDS = ['method', 'path', 'jsonPath'];

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function assertObject(value, label, allowedFields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  for (const field of Object.keys(value)) {
    if (!allowedFields.includes(field)) {
      throw new Error(`${label} contains unsupported field: ${field}`);
    }
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(`${label} must be a lowercase identifier`);
  }
}

function assertLiteralPath(path, label, isPrefix = false) {
  if (typeof path !== 'string' || !/^\/[a-zA-Z0-9/_.-]*$/.test(path)) {
    throw new Error(`${label} must be a literal ASCII URL path`);
  }

  const hasDotSegments = path.split('/').some((segment) => segment === '.' || segment === '..');
  if (path.includes('//') || hasDotSegments) {
    throw new Error(`${label} contains ambiguous path segments`);
  }

  if (isPrefix && (path === '/' || !path.endsWith('/'))) {
    throw new Error(`${label} prefix must name a specific directory`);
  }

  if (!isPrefix && path.length > 1 && path.endsWith('/')) {
    throw new Error(`${label} exact path must not end in a slash`);
  }
}

function validateRoute(route, index, schemaVersion) {
  const label = `routes[${index}]`;
  assertObject(route, label, ROUTE_FIELDS);
  if (route.request !== undefined) {
    if (schemaVersion !== 2) throw new Error(`${label}.request requires schemaVersion 2`);
    validateRequestContract(route.request, `${label}.request`);
  }

  if (route.access !== 'public' && route.access !== 'auth_flow') {
    throw new Error(`${label} has an unsupported access policy`);
  }

  if (!Array.isArray(route.methods) || route.methods.length === 0) {
    throw new Error(`${label} requires HTTP methods`);
  }

  const methods = new Set(route.methods);
  if (
    methods.size !== route.methods.length ||
    route.methods.some((method) => !HTTP_METHODS.has(method))
  ) {
    throw new Error(`${label} has invalid or duplicate HTTP methods`);
  }

  if (
    (route.exact !== undefined && !Array.isArray(route.exact)) ||
    (route.prefix !== undefined && !Array.isArray(route.prefix))
  ) {
    throw new Error(`${label} paths must be arrays`);
  }

  if ((route.exact?.length ?? 0) + (route.prefix?.length ?? 0) === 0) {
    throw new Error(`${label} must specify at least one path`);
  }

  for (const path of route.exact ?? []) {
    assertLiteralPath(path, `${label}.exact`);
  }

  for (const path of route.prefix ?? []) {
    assertLiteralPath(path, `${label}.prefix`, true);
  }

  if (
    route.rateLimit !== undefined &&
    (route.access !== 'auth_flow' || typeof route.rateLimit !== 'boolean')
  ) {
    throw new Error(`${label}.rateLimit is only available for authentication routes`);
  }
}

function validateCredential(credential, index) {
  const label = `credentials[${index}]`;
  assertObject(credential, label, CREDENTIAL_FIELDS);
  assertIdentifier(credential.id, `${label}.id`);

  if (credential.type !== 'bearer' && credential.type !== 'cookie') {
    throw new Error(`${label} must use bearer or cookie authentication`);
  }

  if (credential.type === 'cookie') {
    if (typeof credential.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(credential.name)) {
      throw new Error(`${label} has an invalid cookie name`);
    }
  } else if (credential.name !== undefined) {
    throw new Error(`${label} bearer credentials cannot specify cookie names`);
  }

  const validation = credential.validation;
  assertObject(validation, `${label}.validation`, VALIDATION_FIELDS);

  if (validation.method !== 'GET' && validation.method !== 'POST') {
    throw new Error(`${label}.validation supports only GET or POST`);
  }

  assertLiteralPath(validation.path, `${label}.validation.path`);

  if (
    typeof validation.jsonPath !== 'string' ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*){0,5}$/.test(validation.jsonPath)
  ) {
    throw new Error(`${label}.validation.jsonPath must be a dotted field path`);
  }
}

export function validateProfile(profile) {
  assertObject(profile, 'profile', PROFILE_FIELDS);

  if (
    ![1, 2].includes(profile.schemaVersion) ||
    !Number.isSafeInteger(profile.epoch) ||
    profile.epoch < 1
  ) {
    throw new Error('Unsupported profile schema version or epoch');
  }

  assertIdentifier(profile.id, 'profile.id');

  if (
    typeof profile.hostname !== 'string' ||
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      profile.hostname,
    )
  ) {
    throw new Error('profile.hostname must be a lowercase DNS hostname');
  }

  if (
    !Number.isInteger(profile.retentionDays) ||
    profile.retentionDays < 1 ||
    profile.retentionDays > 90
  ) {
    throw new Error('profile.retentionDays must be between 1 and 90');
  }

  if (
    !Number.isInteger(profile.validationTimeoutMs) ||
    profile.validationTimeoutMs < 100 ||
    profile.validationTimeoutMs > 10_000
  ) {
    throw new Error('profile.validationTimeoutMs must be between 100 and 10000');
  }

  if (!Array.isArray(profile.routes) || profile.routes.length > 100) {
    throw new Error('profile.routes must contain at most 100 rules');
  }

  profile.routes.forEach((route, index) => validateRoute(route, index, profile.schemaVersion));

  if (
    !Array.isArray(profile.credentials) ||
    profile.credentials.length === 0 ||
    profile.credentials.length > 4
  ) {
    throw new Error('profile.credentials must contain between 1 and 4 schemes');
  }

  profile.credentials.forEach(validateCredential);

  const identifiers = profile.credentials.map((credential) => credential.id);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error('Credential scheme identifiers must be unique');
  }

  return profile;
}

/**
 * Treat noncanonical paths as protected. They may still reach an authenticated
 * upstream, but are never granted access by the public-route allowlist.
 */
export function matchRoute(profile, request) {
  const pathname = new URL(request.url).pathname;

  if (/%|\\|\/\//.test(pathname)) {
    return { access: 'protected' };
  }

  for (const route of profile.routes) {
    if (!route.methods.includes(request.method)) {
      continue;
    }

    const matchesExact = route.exact?.includes(pathname) ?? false;
    const matchesPrefix = route.prefix?.some((prefix) => pathname.startsWith(prefix)) ?? false;

    if (matchesExact || matchesPrefix) {
      return route;
    }
  }

  return { access: 'protected' };
}
