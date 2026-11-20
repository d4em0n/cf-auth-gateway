const MAX_BODY_BYTES = 65_536;
const TYPES = ['string', 'number', 'integer', 'boolean', 'null'];
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

function object(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new Error(`${label} contains unsupported field: ${field}`);
  }
}

export function validateRequestContract(contract, label) {
  object(contract, ['contentTypes', 'maxBodyBytes', 'json', 'denyHeaders'], label);
  if (contract.denyHeaders !== undefined) {
    if (
      !Array.isArray(contract.denyHeaders) ||
      contract.denyHeaders.length > 32 ||
      contract.denyHeaders.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9-]+$/.test(name))
    ) {
      throw new Error(`${label}.denyHeaders must contain at most 32 literal header names`);
    }
  }
  if (contract.maxBodyBytes !== undefined) {
    if (
      !Number.isInteger(contract.maxBodyBytes) ||
      contract.maxBodyBytes < 0 ||
      contract.maxBodyBytes > MAX_BODY_BYTES
    ) {
      throw new Error(`${label}.maxBodyBytes must be between 0 and ${MAX_BODY_BYTES}`);
    }
  }
  if (contract.contentTypes !== undefined) {
    if (
      !Array.isArray(contract.contentTypes) ||
      contract.contentTypes.length === 0 ||
      contract.contentTypes.length > 16 ||
      contract.contentTypes.some((type) => typeof type !== 'string' || !MEDIA_TYPE.test(type))
    ) {
      throw new Error(`${label}.contentTypes must contain literal lowercase media types`);
    }
  }
  if (
    (contract.contentTypes !== undefined || contract.json !== undefined) &&
    contract.maxBodyBytes === undefined
  ) {
    throw new Error(`${label} body validation requires maxBodyBytes`);
  }
  if (contract.json === undefined) return;
  if (
    !contract.contentTypes?.every(
      (type) => type === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type),
    ) ||
    contract.maxBodyBytes === 0
  ) {
    throw new Error(`${label}.json requires JSON contentTypes and a positive maxBodyBytes`);
  }
  const schema = contract.json;
  object(schema, ['type', 'required', 'additionalProperties', 'properties'], `${label}.json`);
  if (schema.type !== 'object') throw new Error(`${label}.json.type must be object`);
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  ) {
    throw new Error(`${label}.json.additionalProperties must be boolean`);
  }
  object(schema.properties, Object.keys(schema.properties ?? {}), `${label}.json.properties`);
  const names = Object.keys(schema.properties);
  if (
    names.length > 64 ||
    names.some(
      (name) =>
        !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name) ||
        ['__proto__', 'constructor', 'prototype'].includes(name),
    )
  ) {
    throw new Error(`${label}.json.properties has invalid names or more than 64 fields`);
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some((name) => !names.includes(name)))
  ) {
    throw new Error(`${label}.json.required must name unique declared properties`);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    object(property, ['type', 'maxLength'], `${label}.json.properties.${name}`);
    if (!TYPES.includes(property.type)) throw new Error(`${label}: unsupported primitive type`);
    if (
      property.maxLength !== undefined &&
      (property.type !== 'string' ||
        !Number.isInteger(property.maxLength) ||
        property.maxLength < 0 ||
        property.maxLength > MAX_BODY_BYTES)
    ) {
      throw new Error(
        `${label}: maxLength requires a string and an integer between 0 and ${MAX_BODY_BYTES}`,
      );
    }
  }
}
