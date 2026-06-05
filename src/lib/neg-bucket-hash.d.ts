// Type-only companion for the JS SSoT module src/lib/neg-bucket-hash.js.
// The worker imports the runtime functions from the `.js`; these declarations
// give TS the signatures + the literal NEG_BUCKET_COUNT.

export const NEG_BUCKET_COUNT: 1024;

export interface NegSubject {
    compound_id?: string;
    target_id?: string;
    paper_id?: string;
    trial_id?: string;
    bioactivity_id?: string;
}

export interface NegKeyable {
    id?: string;
    subject?: NegSubject;
    compound_id?: string;
    trial_id?: string;
    bioactivity_id?: string;
    paper_id?: string;
    target_id?: string;
}

export function negKeyOf(record: NegKeyable): string;
export function fnv1a32(str: string): number;
export function negBucketOf(key: string): number;
