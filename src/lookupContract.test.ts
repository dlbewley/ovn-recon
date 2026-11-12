// The lookup contract has three spellings: the Go types the collector
// encodes, the published JSON schema, and the TypeScript types the plugin
// decodes into. The collector's tests hold Go and the schema together
// (collector/internal/snapshot/lookup_contract_test.go); this file holds
// TypeScript and the schema together, so the three cannot drift apart.
import schema from '../collector/api/lookup-response.schema.json';
import {
    LOOKUP_CONSTRUCT_KINDS,
    LOOKUP_FIELDS,
    LOOKUP_KINDS,
    LOOKUP_MATCH_TYPES,
    LOOKUP_TABLES,
    LogicalTopologyWarning,
    LookupConstruct,
    LookupHit,
    LookupOwner,
    LookupQuery,
    LookupResponse,
    LookupZone,
} from './types';

/** The keys of T that are not optional. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K }[keyof T];

// Each of these objects must name exactly the keys of its type: a key the
// type lacks is an excess property and a key it has but the object omits is
// a missing one, and either fails compilation (ts-jest reports it as a test
// failure). The assertions below then compare the names with the schema.
const responseKeys: Record<keyof LookupResponse, true> = {
    query: true,
    hits: true,
    total: true,
    limit: true,
    truncated: true,
    zones: true,
    warnings: true,
};
const responseRequired: Record<RequiredKeys<LookupResponse>, true> = responseKeys;

const queryKeys: Record<keyof LookupQuery, true> = { kind: true, value: true };
const queryRequired: Record<RequiredKeys<LookupQuery>, true> = queryKeys;

const hitKeys: Record<keyof LookupHit, true> = {
    node: true,
    table: true,
    rowUuid: true,
    rowName: true,
    construct: true,
    network: true,
    owner: true,
    matchedField: true,
    matchedValue: true,
    matchedValues: true,
    matchType: true,
    snapshotGeneratedAt: true,
};
const hitRequired: Record<RequiredKeys<LookupHit>, true> = {
    node: true,
    table: true,
    rowUuid: true,
    network: true,
    matchedField: true,
    matchedValue: true,
    matchType: true,
    snapshotGeneratedAt: true,
};

const constructKeys: Record<keyof LookupConstruct, true> = { kind: true, name: true, uuid: true };
const constructRequired: Record<RequiredKeys<LookupConstruct>, true> = constructKeys;

const ownerKeys: Record<keyof LookupOwner, true> = { kind: true, namespace: true, name: true };
const ownerRequired: Record<RequiredKeys<LookupOwner>, true> = { kind: true, name: true };

const zoneKeys: Record<keyof LookupZone, true> = { node: true, snapshotGeneratedAt: true, sourceHealth: true };
const zoneRequired: Record<RequiredKeys<LookupZone>, true> = zoneKeys;

const warningKeys: Record<keyof LogicalTopologyWarning, true> = { code: true, message: true };
const warningRequired: Record<RequiredKeys<LogicalTopologyWarning>, true> = warningKeys;

const hitSchema = schema.properties.hits.items;

const objects = [
    { name: 'response', schema, keys: responseKeys, required: responseRequired },
    { name: 'query', schema: schema.properties.query, keys: queryKeys, required: queryRequired },
    { name: 'hit', schema: hitSchema, keys: hitKeys, required: hitRequired },
    { name: 'construct', schema: hitSchema.properties.construct, keys: constructKeys, required: constructRequired },
    { name: 'owner', schema: hitSchema.properties.owner, keys: ownerKeys, required: ownerRequired },
    { name: 'zone', schema: schema.properties.zones.items, keys: zoneKeys, required: zoneRequired },
    { name: 'warning', schema: schema.properties.warnings.items, keys: warningKeys, required: warningRequired },
];

describe('lookup contract: TypeScript types against the JSON schema', () => {
    it.each(objects)('$name has the fields the schema defines', ({ schema: objectSchema, keys }) => {
        expect(Object.keys(keys).sort()).toEqual(Object.keys(objectSchema.properties).sort());
        expect(objectSchema.additionalProperties).toBe(false);
    });

    it.each(objects)('$name makes optional exactly what the schema does not require', ({ schema: objectSchema, required }) => {
        expect(Object.keys(required).sort()).toEqual([...objectSchema.required].sort());
    });

    // Compared as written: the order of match types and tables is the order
    // hits are returned in.
    it('lists the same values as the schema enums, in the same order', () => {
        expect([...LOOKUP_KINDS]).toEqual(schema.properties.query.properties.kind.enum);
        expect([...LOOKUP_TABLES]).toEqual(hitSchema.properties.table.enum);
        expect([...LOOKUP_FIELDS]).toEqual(hitSchema.properties.matchedField.enum);
        expect([...LOOKUP_MATCH_TYPES]).toEqual(hitSchema.properties.matchType.enum);
        expect([...LOOKUP_CONSTRUCT_KINDS]).toEqual(hitSchema.properties.construct.properties.kind.enum);
    });
});
