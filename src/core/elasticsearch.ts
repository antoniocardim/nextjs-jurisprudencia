import { canBeActive } from "@/types/keys";
import { Client } from "@elastic/elasticsearch";
import { AggregationsAggregate, AggregationsAggregationContainer, AggregationsStringTermsBucket, AggregationsTermsAggregation, QueryDslQueryContainer, SearchRequest, SearchResponse, SortCombinations } from "@elastic/elasticsearch/lib/api/types";
import { isJurisprudenciaDocumentGenericKey, JurisprudenciaDocument, JurisprudenciaDocumentDateKey, JurisprudenciaDocumentDateKeys, JurisprudenciaDocumentExactKeys, JurisprudenciaDocumentGenericKeys, JurisprudenciaDocumentKeys, JurisprudenciaDocumentProperties, JurisprudenciaDocumentStateValue, JurisprudenciaDocumentStateValues, JurisprudenciaDocumentTextKeys, JurisprudenciaVersion } from "@stjiris/jurisprudencia-document";

export const filterableProps = JurisprudenciaDocumentKeys.filter(canBeActive);

const DATA_FIELD: JurisprudenciaDocumentDateKey = "Data";
const ENV_PUBLIC_STATES = process.env.PUBLIC_STATES?.trim().split(",") || [];
export const PUBLIC_STATES = ENV_PUBLIC_STATES.filter(
    (state): state is JurisprudenciaDocumentStateValue =>
        JurisprudenciaDocumentStateValues.includes(state as JurisprudenciaDocumentStateValue)
);

export const aggs = {
    MinAno: {
        min: {
            field: DATA_FIELD,
            format: 'yyyy'
        }
    },
    MaxAno: {
        max: {
            field: DATA_FIELD,
            format: 'yyyy'
        }
    }
} as Record<string, AggregationsAggregationContainer>;
filterableProps.forEach(name => {
    let key = name
    if (isJurisprudenciaDocumentGenericKey(name)) {
        key += ".Index.keyword"
    }
    aggs[name] = {
        terms: {
            field: key,
            size: 65536,
            order: {
                _key: "asc"
            }
        }
    }
});

export const DEFAULT_AGGS = {
    MaxAno: aggs.MaxAno,
    MinAno: aggs.MinAno
};
export const DEFAULT_RESULTS_PER_PAGE = 10;

export async function getElasticSearchClient() {
    return new Client({ node: process.env.ES_URL || "http://localhost:9200", auth: { username: "elastic", password: "elasticsearch" } })
}

export type SearchFilters = {
    pre: QueryDslQueryContainer[];
    after: QueryDslQueryContainer[];
};

export default async function search(
    query: QueryDslQueryContainer | QueryDslQueryContainer[],
    filters: SearchFilters = { pre: [], after: [] },
    page: number = 0,
    saggs: Record<string, AggregationsAggregationContainer> = DEFAULT_AGGS,
    rpp = DEFAULT_RESULTS_PER_PAGE,
    extras: Partial<SearchRequest> = {}, all: boolean = false): Promise<SearchResponse<JurisprudenciaDocument, Record<string, AggregationsAggregate>>> {

    const must = Array.isArray(query) ? query : [query];
    if (!all) {
        must.push({ terms: { STATE: PUBLIC_STATES } })
    }
    const client = await getElasticSearchClient();
    return await client.search<JurisprudenciaDocument>({
        index: JurisprudenciaVersion,
        query: {
            bool: {
                must: must,
                filter: filters.pre
            }
        },
        post_filter: {
            bool: {
                filter: filters.after
            }
        },
        aggs: saggs,
        size: rpp,
        from: page * rpp,
        track_total_hits: true,
        _source: (filterableProps as any[]).concat("Sumário"),
        ...extras // Allows 
    });
}

export function padZero(num: number | string, size: number = 4): string {
    return num.toString().padStart(size, "0");
}

// Helper to normalize field values to arrays
function normalizeArray(value: string | string[] | undefined): string[] {
    if (!value) return [];
    return (Array.isArray(value) ? value : [value]).filter(o => o.length > 0);
}

// Helper to build term or wildcard query based on value
function buildTermOrWildcardQuery(value: string, fieldName: string): QueryDslQueryContainer {
    return (value.startsWith("\"") && value.endsWith("\"")) ? {
        term: {
            [fieldName.replace("keyword", "raw")]: { value: `${value.slice(1, -1)}` }
        }
    } : {
        wildcard: {
            [fieldName]: { value: `*${value}*` }
        }
    };
}

export function populateFilters(filters: SearchFilters, body: Partial<Record<string, string | string[]>> = {}, afters = ["MinDate", "MaxDate"]) {
    const filtersUsed = {} as Record<string, string[]>;

    const isSafeForQueryString = (value: string): boolean => {
        const quoteCount = (value.match(/"/g) || []).length;
        return quoteCount % 2 === 0;
    };

    for (let key in aggs) {
        let aggName = key;
        let aggObj = aggs[key];
        let aggField = (aggObj.terms ? "terms" : "significant_terms") as keyof AggregationsAggregationContainer;
        if (!aggObj[aggField]) continue;
        if (body[aggName]) {
            filtersUsed[aggName] = normalizeArray(body[aggName]);
            let when = "pre" as keyof SearchFilters;
            if (afters.includes(aggName)) {
                when = "after" as keyof SearchFilters;
            }
            let fieldName = (aggObj[aggField] as AggregationsTermsAggregation).field!;
            let should = filtersUsed[aggName].filter(o => !o.startsWith("not:"))
            let must_not = filtersUsed[aggName].filter(o => o.startsWith("not:")).map(o => o.substring(4))
            let must_or_should = !isJurisprudenciaDocumentGenericKey(aggName) || body["_should"]?.includes(aggName) ? "should" : "must"  // AND or OR - if a signle value use alawys OR else default OR but flag for AND

            // Detect advanced operators in any value
            const hasAdvanced = (arr: string[]) => arr.some(v => /[\(\)\"\bAND\b|\bOR\b|\bNOT\b]/i.test(v));
            const shouldQueryString = should.join(" ");
            if (should.length && hasAdvanced(should) && isSafeForQueryString(shouldQueryString)) {
                filters[when].push({
                    query_string: {
                        query: shouldQueryString,
                        fields: [fieldName],
                        default_operator: "OR"
                    }
                });
            } else if (should.length) {
                filters[when].push({
                    bool: {
                        [must_or_should]: should.map(o => buildTermOrWildcardQuery(o, fieldName))
                    }
                });
            }
            const mustNotQueryString = must_not.join(" ");
            if (must_not.length && hasAdvanced(must_not) && isSafeForQueryString(mustNotQueryString)) {
                filters[when].push({
                    bool: {
                        must_not: [
                            {
                                query_string: {
                                    query: mustNotQueryString,
                                    fields: [fieldName],
                                    default_operator: "OR"
                                }
                            }
                        ]
                    }
                });
            } else if (must_not.length) {
                filters[when].push({
                    bool: {
                        must_not: must_not.map(o => buildTermOrWildcardQuery(o, fieldName))
                    }
                });
            }
        }
    }

    let dateWhen = "pre" as keyof SearchFilters;
    if (afters.includes("MinDate") || afters.includes("MaxDate"))
        dateWhen = "after";
    let minDate = Array.isArray(body.MinDate) ? body.MinDate[0] : body.MinDate;
    let maxDate = Array.isArray(body.MaxDate) ? body.MaxDate[0] : body.MaxDate;

    if (minDate || maxDate) {
        const rangeQuery: any = {
            range: {
                [DATA_FIELD]: {
                    format: "dd/MM/yyyy"
                }
            }
        };
        if (minDate) {
            const [year, month, day] = minDate.split('-');
            const formattedMinDate = `${day}/${month}/${year}`;

            rangeQuery.range[DATA_FIELD].gte = formattedMinDate;
            filtersUsed.MinDate = [formattedMinDate];
        }
        if (maxDate) {
            const [year, month, day] = maxDate.split('-');
            const formattedMaxDate = `${day}/${month}/${year}`;

            rangeQuery.range[DATA_FIELD].lte = formattedMaxDate;
            filtersUsed.MaxDate = [formattedMaxDate];
        }
        filters[dateWhen].push(rangeQuery);
    }

    if (body.notHasField) {
        filtersUsed.notHasField = normalizeArray(body.notHasField);
        filtersUsed.notHasField.forEach(field => {
            filters.pre.push({
                bool: {
                    must_not: {
                        exists: {
                            field: field
                        }
                    }
                }
            });
        });
    }
    if (body.hasField) {
        filtersUsed.hasField = normalizeArray(body.hasField);
        filtersUsed.hasField.forEach(field => {
            filters.pre.push({
                bool: {
                    must: {
                        exists: {
                            field: field
                        }
                    },
                    must_not: {
                        term: {
                            [field]: ""
                        }
                    }
                }
            });
        });
    }
    if (body.mustHaveText) {
        filtersUsed.mustHaveText = ["true"];
        filters.pre.push({
            bool: {
                must: {
                    exists: {
                        field: "Texto"
                    }
                }
            }
        });
    }
    return filtersUsed;
}

export function parseSort(value: string | undefined, array: SortCombinations[]): string {
    const sortV = value || "des";
    if (sortV == "des") {
        array.push({
            [DATA_FIELD]: { order: "desc" }
        });
    }
    else if (sortV == "asc") {
        array.push({
            [DATA_FIELD]: { order: "asc" }
        });
    }
    else if (sortV == "score") {
        array.push({
            _score: { order: "desc" }
        });
        array.push({
            [DATA_FIELD]: { order: "desc" }
        })
    }
    return sortV;
}

export function createQueryDslQueryContainer(string?: string | string[]): QueryDslQueryContainer | QueryDslQueryContainer[] {
    if (!string) {
        return {
            match_all: {}
        };
    }
    const raw = Array.isArray(string) ? string.join(" ") : string;
    const query = raw.trim();
    if (!query) {
        return {
            match_all: {}
        };
    }

    // Helper to safely get field name from document keys array
    const getFieldName = <T extends string>(keysArray: readonly T[], fieldName: T, suffix?: string): string => {
        const found = keysArray.find(key => key === fieldName) || fieldName;
        return suffix ? `${found}${suffix}` : found;
    };

    const sumarioField = getFieldName(JurisprudenciaDocumentTextKeys, "Sumário" as any);
    const textoField = getFieldName(JurisprudenciaDocumentTextKeys, "Texto" as any);
    const descritoresField = getFieldName(JurisprudenciaDocumentGenericKeys, "Descritores" as any, ".Index");
    const numeroProcessoField = getFieldName(JurisprudenciaDocumentKeys, "Número de Processo" as any);
    const ecliField = getFieldName(JurisprudenciaDocumentExactKeys, "ECLI" as any);

    const multiMatchFields = [
        `${sumarioField}^10`,
        `${textoField}^5`,
        `${descritoresField}^1`
    ];

    const caseNumberPattern = /^\d{1,7}\/\d{2}\.[0-9A-Z]{3,8}\.[0-9A-Z]{1,4}$/i;
    const multiMatchQuery: QueryDslQueryContainer = {
        multi_match: {
            query,
            type: "best_fields",
            fields: multiMatchFields,
            fuzziness: "AUTO"
        }
    };

    const descritoresWithTextoBoost: QueryDslQueryContainer = {
        bool: {
            must: [
                { match: { [descritoresField]: { query } } },
                { match: { [textoField]: { query } } }
            ],
            boost: 20
        }
    };

    const descritoresLowBoost: QueryDslQueryContainer = {
        match: {
            [descritoresField]: {
                query,
                boost: 0.2
            }
        }
    };

    if (caseNumberPattern.test(query)) {
        return {
            bool: {
                should: [
                    {
                        match_phrase: {
                            [numeroProcessoField]: {
                                query,
                                boost: 100
                            }
                        }
                    },
                    {
                        match_phrase: {
                            [ecliField]: {
                                query,
                                boost: 100
                            }
                        }
                    },
                    multiMatchQuery
                ],
                minimum_should_match: 1
            }
        };
    }

    return {
        bool: {
            should: [
                {
                    match_phrase: {
                        [descritoresField]: {
                            query,
                            boost: 20
                        }
                    }
                },
                {
                    match_phrase: {
                        [sumarioField]: {
                            query,
                            boost: 20
                        }
                    }
                },
                descritoresWithTextoBoost,
                descritoresLowBoost,
                multiMatchQuery
            ],
            minimum_should_match: 1
        }
    };
}


export async function getSearchedArray(text: string): Promise<string[]> {
    try {
        const c = await getElasticSearchClient();
        const r = await c.indices.analyze({ index: JurisprudenciaVersion, text: text });
        return r.tokens?.map(o => o.token) || [];
    } catch (e) {
        return [] as string[];
    }
}

export async function getAutocompleteSuggestions(text: string): Promise<{ text: string, type: string, docCount: number, totalOccurrences: number }[]> {
    const queryText = text?.trim();
    if (!queryText) return [];

    // Helper to safely get field name from document keys array
    const getFieldName = <T extends string>(keysArray: readonly T[], fieldName: T, suffix?: string): string => {
        const found = keysArray.find(key => key === fieldName) || fieldName;
        return suffix ? `${found}${suffix}` : found;
    };

    const fieldDefs = [
        { key: "Descritores", field: getFieldName(JurisprudenciaDocumentGenericKeys, "Descritores" as any, ".Index") },
        { key: "Relator Nome Profissional", field: getFieldName(JurisprudenciaDocumentGenericKeys, "Relator Nome Profissional" as any, ".Index") },
        { key: "Área", field: getFieldName(JurisprudenciaDocumentGenericKeys, "Área" as any, ".Index") },
        { key: "Secção", field: getFieldName(JurisprudenciaDocumentGenericKeys, "Secção" as any, ".Index") },
        { key: "Meio Processual", field: getFieldName(JurisprudenciaDocumentGenericKeys, "Meio Processual" as any, ".Index") },
        { key: "Votação", field: getFieldName(JurisprudenciaDocumentGenericKeys, "Votação" as any, ".Index") },
        { key: "Sumário", field: getFieldName(JurisprudenciaDocumentTextKeys, "Sumário" as any) },
        { key: "Texto", field: getFieldName(JurisprudenciaDocumentTextKeys, "Texto" as any) }
    ];
    const maxTextSuggestionLength = 120;
    const escapedLower = queryText.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const includePattern = `${escapedLower}.*`;

    try {
        const client = await getElasticSearchClient();

        // Helper to create standard aggregation for terms
        const createTermsAgg = (field: string, includePattern: string) => ({
            terms: { field: `${field}.keyword`, size: 10, include: includePattern },
            aggs: { total_occurrences: { value_count: { field: `${field}.keyword` } } }
        });

        // Define aggregation configuration
        const aggConfigs = [
            { aggKey: "descritores", fieldIndex: 0, type: "Descritores" },
            { aggKey: "relator", fieldIndex: 1, type: "Relator Nome Profissional" },
            { aggKey: "area", fieldIndex: 2, type: "Área" },
            { aggKey: "secao", fieldIndex: 3, type: "Secção" },
            { aggKey: "meioProcessual", fieldIndex: 4, type: "Meio Processual" },
            { aggKey: "votacao", fieldIndex: 5, type: "Votação" }
        ];

        // Build aggregations dynamically
        const aggs: Record<string, any> = {};
        for (const { aggKey, fieldIndex } of aggConfigs) {
            aggs[aggKey] = createTermsAgg(fieldDefs[fieldIndex].field, includePattern);
        }
        // Add text aggregations
        aggs.sumario = {
            filter: { match_phrase_prefix: { [fieldDefs[6].field]: { query: queryText } } },
            aggs: { terms_agg: { significant_text: { field: fieldDefs[6].field, size: 10, min_doc_count: 1 } } }
        };
        aggs.texto = {
            filter: { match_phrase_prefix: { [fieldDefs[7].field]: { query: queryText } } },
            aggs: { terms_agg: { significant_text: { field: fieldDefs[7].field, size: 10, min_doc_count: 1 } } }
        };

        const response = await client.search<JurisprudenciaDocument, Record<string, AggregationsAggregate>>({
            index: JurisprudenciaVersion,
            size: 0,
            query: {
                bool: {
                    should: fieldDefs.map(({ field }) => ({
                        match_phrase_prefix: { [field]: { query: queryText } }
                    })),
                    minimum_should_match: 1
                }
            },
            aggs
        });

        const aggMap = aggConfigs.map(c => ({ key: c.aggKey, type: c.type }));

        const unique = new Map<string, { text: string; type: string; docCount: number; totalOccurrences: number }>();

        // Helper to process and add bucket suggestions
        const processBuckets = (buckets: AggregationsStringTermsBucket[], type: string, textLimit?: number) => {
            for (const bucket of buckets) {
                if (typeof bucket.key === "string") {
                    const text = textLimit && bucket.key.length > textLimit
                        ? bucket.key.slice(0, textLimit).trim()
                        : bucket.key;
                    const id = `${type}:${text}`;
                    if (!unique.has(id)) {
                        const totalOccurrences = typeof bucket.total_occurrences?.value === "number"
                            ? bucket.total_occurrences.value
                            : bucket.doc_count;
                        unique.set(id, { text, type, docCount: bucket.doc_count, totalOccurrences });
                    }
                }
            }
        };

        for (const { key, type } of aggMap) {
            const agg = (response.aggregations as Record<string, { buckets?: Array<AggregationsStringTermsBucket & { total_occurrences?: { value?: number } }> }> | undefined)?.[key];
            const buckets = Array.isArray(agg?.buckets) ? agg!.buckets : [];
            processBuckets(buckets, type, undefined);
        }

        const textAggs: Array<{ key: "sumario" | "texto"; type: string }> = [
            { key: "sumario", type: "Sumario" },
            { key: "texto", type: "Texto" }
        ];

        for (const { key, type } of textAggs) {
            const aggregations = response.aggregations as Record<string, { terms_agg?: { buckets?: Array<AggregationsStringTermsBucket & { total_occurrences?: { value?: number } }> } }> | undefined;
            const agg = aggregations?.[key]?.terms_agg;
            const buckets = Array.isArray(agg?.buckets) ? agg!.buckets : [];
            processBuckets(buckets, type, maxTextSuggestionLength);
        }

        const results = Array.from(unique.values()).slice(0, 30);
        return results;
    } catch (e) {
        console.error("Error in getAutocompleteSuggestions:", e);
        return [];
    }
}

export function sortAlphabetically(a: string, b: string): number {
    if (a.startsWith("«") && !b.startsWith("«"))
        return 1;
    if (b.startsWith("«") && !a.startsWith("«"))
        return -1;
    let ak = a.replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ0-9]*/, "");
    let bk = b.replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ0-9]*/, "");
    return ak.localeCompare(bk);
}

export function sortBucketsAlphabetically(a: AggregationsStringTermsBucket, b: AggregationsStringTermsBucket): number {
    return sortAlphabetically(a.key, b.key);
}