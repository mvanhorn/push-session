import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MASK = "[redacted]";

// Well-known credential shapes, each with the kind it is counted as. A pattern keeps group 1 (a label
// or prefix) and masks the rest. A third entry is a check the match must also pass. The looser checks
// belong to the any-case assignment rules only: the others mask whatever follows the name.
const PATTERNS = [
  ["private-key", /()-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["aws", /()\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["anthropic", /()\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["openai", /()\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g],
  ["github", /()\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["slack", /()\bxox[abeprs]-[A-Za-z0-9-]{10,}/g],
  ["gitlab", /()(?<![\w-])glpat-[A-Za-z0-9_-]{20,}/g],
  ["stripe", /()(?<![\w-])(?:sk|rk)_live_[A-Za-z0-9]{16,}/g],
  ["google", /()(?<![\w-])AIza[A-Za-z0-9_-]{35}(?![\w-])/g],
  ["npm", /()(?<![\w-])npm_[A-Za-z0-9]{36}(?![\w-])/g],
  // The password of scheme://user:password@host; the user, which may be empty, and the host stay.
  // Neither part runs past a quote or a bracket, so the match stays inside the string the URL is in.
  // A password may hold a "?" or "#" that was pasted unencoded; a port followed by one is a query or
  // fragment that happens to hold an "@", not a password.
  ["url-password", /(\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s/:@?#"'`\\<>{}]{0,256}:)(?!\[redacted\])[^\s/@"'`\\<>{}]{1,512}(?=@[^\s/@?#"'`\\<>{}])/g, (value) => !isPlaceholder(value) && !/^\d{1,5}[?#]/.test(value)],
  // Authorization headers: the scheme stays, the credential goes. In a header any length is a
  // credential; on its own, "Bearer" or "Basic" needs a long token after it to count.
  ["authorization", /(\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)(?!\[redacted\])[^\s"'\\,;]+/gi],
  // Schemes whose credential is several fields. In a quoted value ("Authorization": "Digest ...") or
  // a quoted header ('Authorization: Digest ...') everything up to the closing quote goes, so what
  // follows it stays. Otherwise everything to the end of the line goes, unless it is the mask already.
  // The three shapes do not overlap: the last one takes neither a quoted value nor a quoted header.
  ["authorization", /(\bAuthorization["']?\s*[:=]\s*(["'])(?:Digest|Negotiate|NTLM)\s+)(?!\[redacted\]\2)(?:\\[\s\S]|(?!\2)[^\\\n])+(?=\2)/gi],
  ["authorization", /((["'])(?:Proxy-)?Authorization\s*:\s*(?:Digest|Negotiate|NTLM)\s+)(?!\[redacted\]\2)(?:\\[\s\S]|(?!\2)[^\\\n])+(?=\2)/gi],
  ["authorization", /((?:\bAuthorization["']|(?<!["'](?:Proxy-)?)\bAuthorization)\s*[:=]\s*(?:Digest|Negotiate|NTLM)\s+)(?!\[redacted\][ \t]*(?:\n|$))[^\n]+/gi],
  ["authorization", /(\b(?:Bearer|Basic)\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{20,}/g],
  // Environment-style NAME_KEY=value assignments; the name stays readable. A quoted value is masked
  // up to its closing quote, spaces and escaped quotes included, so none of it is left behind.
  ["assignment", /(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=(["']))(?!\[redacted\])(?:\\[\s\S]|(?!\2)[^\\]){8,}(?=\2)/g],
  // The same inside a JSON string, where the quotes themselves are escaped and a quote escaped
  // within the value is written \\\". Each alternative starts differently, so a value that never
  // closes is given up on at once instead of being split every possible way.
  ["assignment", /(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=\\(["']))(?!\[redacted\])(?:\\\\(?:\\[\s\S]|[^\\])|\\(?!\\|\2)[\s\S]|[^\\]){8,}(?=\\\2)/g],
  // A value that reading finds no end for, such as one whose last character is a backslash, is
  // masked up to the first quote after it instead of being left as it is.
  ["assignment", /(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=\\(["']))(?!\[redacted\])(?:\\\\|\\(?!\\|\2)[\s\S]|[^\\]){8,}?(?=\\\2)/g],
  ["assignment", /(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=)(?!\[redacted\])[^\s"'\\,;]{8,}/g],
  // Quoted "apiKey": "value" pairs, including JSON nested inside a string. The value must be one
  // word with a digit or symbol, so interface copy such as "password": "Password" is left alone.
  ["assignment", /(["'][A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd)[A-Za-z0-9_-]*\\?["']\s*:\s*\\?["'])(?!\[redacted\])(?=[^\s"'\\]*[\d_+/=.-])[^\s"'\\]{8,}(?=\\?["'])/gi],
  // Assignments in any case and with spaces round the "=", as code and config write them:
  // password = "hunter2hunter2", token=abc12345. The name must end in a credential word, so
  // tokenizer and max_tokens are not names. A quoted value is one word with a digit or symbol; a
  // bare value has a digit and is not a placeholder, a path, a call, or a property such as config.token.
  ["assignment", /((?<![\w.-])[A-Za-z_][\w.-]{0,80}[ \t]*=[ \t]*(["']))(?!\[redacted\])(?=[^\s"'\\]{0,200}[\d_+/=.-])[^\s"'\\]{8,}(?=\2)/g, (_value, keep) => namesCredential(keep)],
  ["assignment", /((?<![\w.-])[A-Za-z_][\w.-]{0,80}[ \t]*=[ \t]*)(?![=>~]|\[redacted\])(?=[^\s"'`,;<>()[\]{}&\\]{0,200}\d)[^\s"'`,;<>()[\]{}&\\]{8,}/g,
    (value, keep, next) => namesCredential(keep) && next !== "(" && !/^[/@!.]/.test(value) && !isPlaceholder(value) && !isCall(value) && !isProperty(value)],
];

// The name before the "=" ends in a credential word: api_key, accessToken, db_password.
function namesCredential(keep) {
  return /(?:api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|secret|token|password|passwd)$/i.test(keep.match(/^[\w.-]+/)[0]);
}

// Stand-ins and variable references are not secrets: ${TOKEN}, $API_KEY, $(cmd), <token>, {{key}},
// %KEY%, ***, changeme. The whole value has to be one, and a bare $name only in capitals: a password
// may start with "$" or "%".
function isPlaceholder(value) {
  return /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|\$\(.*\)|<[^<>]*>|\{\{?[^{}]*\}\}?|%[A-Za-z_][A-Za-z0-9_]*%|\[redacted\])$/.test(value)
    || /^(?:[.*x]+|pass(?:word)?|changeme|redacted)$/i.test(value);
}

// A bare right-hand side that is a call rather than a literal secret: getToken().
function isCall(value) {
  return /^[A-Za-z_$][\w$.]*\(/.test(value);
}

// Or a property: process.env.API_KEY, response.data.token. Its parts are short names, which sets
// it apart from a token that happens to be dotted, such as a JWT.
function isProperty(value) {
  return /^[A-Za-z_$][\w$]{0,23}(?:\.[A-Za-z_$][\w$]{0,23})+$/.test(value);
}

/**
 * Masks the credentials in a string. `kinds` says how many of each kind were masked.
 *
 * Every pattern reads the text as it was written, and what they find is masked in one go. Matches
 * that overlap become one mask over all of them, so a key inside a longer password takes the rest
 * of the password with it, and no pattern ever reads another's mask.
 */
export function redactText(value) {
  const found = [];
  for (const [kind, pattern, check] of PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const start = match.index + match[1].length;
      const end = match.index + match[0].length;
      if (end > start && (!check || check(value.slice(start, end), match[1], value[end]))) found.push({ start, end, kind });
    }
  }
  // Earliest first, and the longest of those that start together: its kind names the merged mask.
  // The sort is stable, so of two equal matches the more specific pattern, listed first, wins.
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const kinds = {};
  let count = 0;
  let text = "";
  let offset = 0;
  for (let index = 0; index < found.length; index += 1) {
    const { start, kind } = found[index];
    let { end } = found[index];
    while (index + 1 < found.length && found[index + 1].start < end) end = Math.max(end, found[index += 1].end);
    text += `${value.slice(offset, start)}${MASK}`;
    kinds[kind] = (kinds[kind] || 0) + 1;
    count += 1;
    offset = end;
  }
  return { text: text + value.slice(offset), count, kinds };
}

// The secrets a gzipped tar holds, by kind: its files sit uncompressed inside, so the patterns apply
// to the unpacked bytes. Null means it could not be unpacked, which is treated as unsafe.
function archiveSecrets(content) {
  try {
    return redactText(gunzipSync(content, { maxOutputLength: 256 * 1024 * 1024 }).toString("latin1")).kinds;
  } catch {
    return null;
  }
}

const CREDENTIAL_FIELD =/api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd/i;
const AUTHORIZATION_FIELD = /^(?:proxy-)?authorization$/i;
const ALREADY_MASKED = /^\s*(?:(?:Bearer|Basic|Digest|Negotiate|NTLM)\s+)?\[redacted\]\s*$/i;
const CREDENTIAL_VALUE = /^(?=\S*[\d_+/=.-])\S{8,}$/;

/**
 * Masks credentials in every string of a transcript, or of recovered artifact and Site sources,
 * and reports how many were masked, in all and by kind. The input is not mutated.
 */
export function redactDeep(input) {
  let count = 0;
  const kinds = {};
  const add = (found) => {
    for (const [kind, number] of Object.entries(found)) {
      kinds[kind] = (kinds[kind] || 0) + number;
      count += number;
    }
  };
  const text = (value, key) => {
    // An Authorization value is a credential whatever its shape. Only one that is already the mask
    // in full, after its scheme, is left as it is.
    if (typeof key === "string" && AUTHORIZATION_FIELD.test(key) && value.trim() && !ALREADY_MASKED.test(value)) {
      add({ authorization: 1 });
      return value.replace(/^(\s*(?:Bearer|Basic|Digest|Negotiate|NTLM)\s+)?[\s\S]*$/i, `$1${MASK}`);
    }
    if (typeof key === "string" && CREDENTIAL_FIELD.test(key) && CREDENTIAL_VALUE.test(value)) {
      add({ assignment: 1 });
      return MASK;
    }
    const result = redactText(value);
    add(result.kinds);
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
      add(found || {});
      if (found === null || Object.keys(found).length > 0 || (count > before && Array.isArray(value.files))) result.archive = null;
    }
    return result;
  };
  const value = walk(input);
  return { value, count, kinds };
}
