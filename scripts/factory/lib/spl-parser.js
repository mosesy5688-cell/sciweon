/**
 * SPL XML Parser — DailyMed Structured Product Labeling
 *
 * Extracts labeling section text from SPL XML by LOINC code.
 * Also handles ZIP archive extraction (DailyMed archives/{setid}.zip format)
 * using Node.js built-in zlib.inflateRaw — no external ZIP library required.
 *
 * SPL is HL7 V3 XML; sections are identified by standard LOINC codes inside
 * <code code="LOINC-CODE" codeSystem="..."/> elements within <section> blocks.
 *
 * Nesting: SPL sections can nest arbitrarily. This parser extracts TOP-LEVEL
 * sections matched by LOINC code and returns all text within that section
 * (including nested sub-sections), which is what an Agent needs to answer
 * prescribing questions.
 *
 * No DOM/XPath dependency — pure string + regex extraction is sufficient for
 * the predictable SPL structure. Stack-based section boundary detection handles
 * nesting correctly without recursion or XML library overhead.
 */

import zlib from 'zlib';
import { promisify } from 'util';

const inflateRaw = promisify(zlib.inflateRaw);

// ZIP local file header and central directory signatures (little-endian uint32)
const ZIP_LOCAL_SIG = 0x04034b50;   // PK\x03\x04
const ZIP_CD_SIG    = 0x02014b50;   // PK\x01\x02
const ZIP_EOCD_SIG  = 0x06054b50;   // PK\x05\x06

// ZIP compression methods
const ZIP_STORE   = 0;
const ZIP_DEFLATE = 8;

/**
 * LOINC section codes Sciweon extracts from SPL.
 * Maps LOINC code → DrugLabel.sections field name.
 */
export const LOINC_SECTIONS = {
    '34066-1': 'boxed_warning',
    '34067-9': 'indications',
    '34068-7': 'dosage',
    '34070-3': 'contraindications',
    '34073-7': 'drug_interactions',
    '34084-4': 'adverse_reactions',
    '43679-0': 'mechanism_of_action',
    '43682-4': 'pharmacokinetics',
    '43685-7': 'warnings_precautions',
};

/**
 * Strip XML/HTML tags and decode common entities → plain text.
 * Collapses consecutive whitespace to single spaces.
 */
export function stripXmlTags(s) {
    return s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract top-level <section>...</section> blocks from XML string.
 * Returns array of raw XML strings (one per top-level section).
 * Depth tracking correctly handles nested <section> elements.
 */
function extractTopLevelSections(xml) {
    const sections = [];
    let depth = 0;
    let start = -1;
    let i = 0;

    while (i < xml.length) {
        if (xml[i] !== '<') { i++; continue; }

        if (xml.startsWith('</section>', i)) {
            depth = Math.max(0, depth - 1);
            if (depth === 0 && start !== -1) {
                sections.push(xml.slice(start, i + '</section>'.length));
                start = -1;
            }
            i += '</section>'.length;
            continue;
        }

        // Match <section> or <section ...> but not <sectionBody> etc.
        if (xml.startsWith('<section', i)) {
            const ch = xml[i + 8];
            if (ch === '>' || ch === ' ' || ch === '\r' || ch === '\n' || ch === '\t') {
                if (depth === 0) start = i;
                depth++;
                const close = xml.indexOf('>', i);
                i = close === -1 ? xml.length : close + 1;
                continue;
            }
        }

        i++;
    }

    return sections;
}

/**
 * Parse SPL XML string → map of section_name → text content.
 *
 * Returns an object with all LOINC_SECTIONS keys present; value is the
 * extracted plain text or null if the section is absent from this label.
 *
 * @param {string} xmlString - Raw SPL XML document
 * @param {number} [maxChars=5000] - Max characters per section (safety cap)
 * @returns {Record<string, string|null>}
 */
export function parseSplSections(xmlString, maxChars = 5000) {
    // Pre-populate all keys with null so caller always gets complete shape
    const result = {};
    for (const name of Object.values(LOINC_SECTIONS)) result[name] = null;

    const topLevel = extractTopLevelSections(xmlString);

    for (const section of topLevel) {
        // Extract the first <code code="LOINC-CODE" ...> in this section
        const codeMatch = section.match(/\bcode="(\d{4,6}-\d)"/);
        if (!codeMatch) continue;

        const sectionName = LOINC_SECTIONS[codeMatch[1]];
        if (!sectionName) continue;
        if (result[sectionName] !== null) continue; // first occurrence wins

        // Strip ALL tags from this section block (includes nested sub-section text)
        const text = stripXmlTags(section);
        result[sectionName] = text.length > 0 ? text.slice(0, maxChars) : null;
    }

    return result;
}

/**
 * Extract the SPL XML file from a DailyMed ZIP archive buffer.
 *
 * Strategy: parse Central Directory from end of ZIP (authoritative source for
 * compressed sizes — local headers may have size=0 when data descriptor is used).
 * Finds the first .xml entry and decompresses it via zlib.inflateRaw (DEFLATE)
 * or returns raw bytes (STORE).
 *
 * @param {Buffer|ArrayBuffer} buffer - Raw ZIP archive bytes
 * @returns {Promise<string|null>} SPL XML string, or null if no .xml entry found
 */
export async function extractXmlFromZip(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    // Locate End of Central Directory record by scanning backward from end.
    // EOCD is at least 22 bytes; comment can follow (up to 65535 bytes).
    let eocd = -1;
    const scanFrom = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= scanFrom; i--) {
        if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('ZIP: EOCD record not found — not a valid ZIP');

    const numEntries = buf.readUInt16LE(eocd + 10);
    const cdOffset   = buf.readUInt32LE(eocd + 16);

    // Parse Central Directory entries to locate the XML file
    let pos = cdOffset;
    for (let e = 0; e < numEntries; e++) {
        if (pos + 46 > buf.length) break;
        if (buf.readUInt32LE(pos) !== ZIP_CD_SIG) break;

        const compression    = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const filenameLen    = buf.readUInt16LE(pos + 28);
        const extraLen       = buf.readUInt16LE(pos + 30);
        const commentLen     = buf.readUInt16LE(pos + 32);
        const lhOffset       = buf.readUInt32LE(pos + 42);
        const filename       = buf.slice(pos + 46, pos + 46 + filenameLen).toString('utf8');

        pos += 46 + filenameLen + extraLen + commentLen;

        if (!filename.toLowerCase().endsWith('.xml')) continue;

        // Jump to local file header to find actual data start
        if (lhOffset + 30 > buf.length || buf.readUInt32LE(lhOffset) !== ZIP_LOCAL_SIG) continue;
        const lhFnLen  = buf.readUInt16LE(lhOffset + 26);
        const lhExLen  = buf.readUInt16LE(lhOffset + 28);
        const dataStart = lhOffset + 30 + lhFnLen + lhExLen;

        if (dataStart + compressedSize > buf.length) continue;
        const compressed = buf.slice(dataStart, dataStart + compressedSize);

        if (compression === ZIP_STORE)   return compressed.toString('utf8');
        if (compression === ZIP_DEFLATE) return (await inflateRaw(compressed)).toString('utf8');
        throw new Error(`ZIP: unsupported compression method ${compression} in ${filename}`);
    }

    return null; // No .xml entry found
}
