import crypto from 'node:crypto';

// Secret patterns commonly appearing in enterprise operational logs
const SECRET_PATTERNS = [
  { name: 'API_KEY', regex: /(?:api[_-]?key|token|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?([A-Za-z0-9_\-\.]{14,})['"]?/gi },
  { name: 'PASSWORD', regex: /(?:password|passwd|pwd|db_pass|secret)\s*[:=]\s*['"]?([^'"\s&,;]{6,})['"]?/gi },
  { name: 'AWS_KEY', regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { name: 'BEARER_TOKEN', regex: /Bearer\s+([A-Za-z0-9\-\._~\+\/]+=*)/gi },
  { name: 'PRIVATE_KEY', regex: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE\s+KEY-----/gi },
  { name: 'JWT_TOKEN', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'DB_CONNECTION_STRING', regex: /(?:postgres|postgresql|mysql|mongodb|redis|mssql):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi },
  { name: 'CREDIT_CARD', regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g },
  { name: 'EMAIL_ADDRESS', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g },
  { name: 'INTERNAL_IP', regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g }
];

/**
 * Calculates Shannon entropy of a given string.
 * High entropy (> 4.2) strongly indicates cryptographic keys, passwords, or encrypted tokens.
 */
export function calculateShannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const frequencies = {};
  for (const char of str) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(frequencies)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Deterministic pseudonymization using SHA-256 with a tenant-local salt.
 * Ensures the SaaS platform never sees raw machine hostnames or user names,
 * while allowing consistent grouping across time.
 */
export function pseudonymizeIdentifier(rawIdentifier, salt = 'local_cust_salt_cicada') {
  if (!rawIdentifier) return 'node-unknown';
  const hash = crypto.createHash('sha256').update(`${salt}:${rawIdentifier}`).digest('hex');
  return `node-${hash.slice(0, 8)}`;
}

export function pseudonymizeUser(rawUser, salt = 'local_cust_salt_cicada') {
  if (!rawUser) return 'usr-unknown';
  const hash = crypto.createHash('sha256').update(`${salt}:${rawUser}`).digest('hex');
  return `usr-${hash.slice(0, 8)}`;
}

/**
 * Scrubs and redacts raw text, stripping any credentials, private keys, or high-entropy tokens.
 * Returns { scrubbedText, redactionCount, detectedTypes }
 */
export function scrubRawContent(rawText) {
  if (typeof rawText !== 'string') {
    return { scrubbedText: '', redactionCount: 0, detectedTypes: [] };
  }

  let scrubbed = rawText;
  let redactionCount = 0;
  const detectedTypes = new Set();

  // 1. Regex pattern scrubbing
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(scrubbed)) {
      scrubbed = scrubbed.replace(pattern.regex, (match, captured) => {
        redactionCount++;
        detectedTypes.add(pattern.name);
        return `[REDACTED_${pattern.name}]`;
      });
    }
  }

  // 2. High entropy token detection on words > 16 chars
  const words = scrubbed.split(/[\s,;:"'()\[\]{}]+/);
  for (const word of words) {
    if (word.length >= 18 && !word.startsWith('[REDACTED_')) {
      const entropy = calculateShannonEntropy(word);
      if (entropy > 4.35) {
        scrubbed = scrubbed.replace(word, '[REDACTED_HIGH_ENTROPY_TOKEN]');
        redactionCount++;
        detectedTypes.add('HIGH_ENTROPY_SECRET');
      }
    }
  }

  return {
    scrubbedText: scrubbed,
    redactionCount,
    detectedTypes: Array.from(detectedTypes)
  };
}
