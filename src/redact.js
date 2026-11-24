import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MASK = "[redacted]";

// Well-known credential shapes. Each pattern keeps group 1 (a label or prefix) and masks the rest.
const PATTERNS = [
  /()-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /()\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /()\bsk-[A-Za-z0-9_-]{20,}/g,
  /()\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  /()\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  // Environment-style NAME_KEY=value assignments; the name stays readable.
  /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=\\?["']?)(?!\[redacted\])[^\s"'\\,;]{8,}/g,
  // Quoted "apiKey": "value" pairs, including JSON nested inside a string. The value must be one
  // word with a digit or symbol, so interface copy such as "password": "Password" is left alone.
  /(["'][A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd)[A-Za-z0-9_-]*\\?["']\s*:\s*\\?["'])(?!\[redacted\])(?=[^\s"'\\]*[\d_+/=.-])[^\s"'\\]{8,}(?=\\?["'])/gi,
];

export function redactText(value) {
  let count = 0;
  let text = value;
  for (const pattern of PATTERNS) {
    text = text.replace(pattern, (_match, keep) => {
      count += 1;
      return `${keep}${MASK}`;
    });
  }
  return { text, count };
}

// How many secrets a gzipped tar holds: its files sit uncompressed inside, so the patterns apply to
// the unpacked bytes. Null means it could not be unpacked, which is treated as unsafe.
function archiveSecrets(content) {
  try {
    return redactText(gunzipSync(content, { maxOutputLength: 256 * 1024 * 1024 }).toString("latin1")).count;
  } catch {
    return null;
  }
}

const CREDENTIAL_FIELD =/api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd/i;
const CREDENTIAL_VALUE = /^(?=\S*[\d_+/=.-])\S{8,}$/;

/**
 * Masks credentials in every string of a transcript, or of recovered artifact and Site sources,
 * and reports how many were masked. The input is not mutated.
 */
export function redactDeep(input) {
  let count = 0;
  const text = (value, key) => {
    if (typeof key === "string" && CREDENTIAL_FIELD.test(key) && CREDENTIAL_VALUE.test(value)) {
      count += 1;
      return MASK;
    }
    const result = redactText(value);
    count += result.count;
    return result.text;
  };
  const walk = (value, key) => {
    if (typeof value === "string") return text(value, key);
    if (Buffer.isBuffer(value)) {
      // Binary files (images, archives) have no text to mask.
      if (value.includes(0)) return value;
      const source = value.toString("utf8");
      const masked = text(source);
      return masked === source ? value : Buffer.from(masked);
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry));
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
    const before = count;
    const result = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, walk(entry, name)]));
    if (result.content !== value.content && (typeof result.content === "string" || Buffer.isBuffer(result.content))) {
      // A masked source file no longer matches its recorded size and hash.
      if ("bytes" in result) result.bytes = Buffer.byteLength(result.content);
      if ("sha256" in result) result.sha256 = createHash("sha256").update(result.content).digest("hex");
    }
    // A packaged archive cannot be masked, so it is left out when it or its files hold secrets.
    if (Buffer.isBuffer(value.archive?.content)) {
      const found = archiveSecrets(value.archive.content);
      count += found || 0;
      if (found !== 0 || (count > before && Array.isArray(value.files))) result.archive = null;
    }
    return result;
  };
  return { value: walk(input), count };
}
