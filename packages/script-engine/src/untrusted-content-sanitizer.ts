/**
 * Sanitizes external untrusted text retrieved from web pages or search engines
 * to prevent prompt injection, instruction override, or conversational hijacking.
 */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/gi,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions|prompts)/gi,
  /system\s*prompt\s*:/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /###\s*(Human|Assistant|System):/gi,
  /you\s+are\s+now\s+in\s+developer\s+mode/gi,
  /do\s+anything\s+now/gi,
];

export interface SanitizeOptions {
  maxLength?: number;
  preserveQuotes?: boolean;
}

export function sanitizeUntrustedContent(
  rawContent: string,
  options: SanitizeOptions = {},
): string {
  if (typeof rawContent !== "string") {
    return "";
  }

  const maxLength = options.maxLength ?? 1200;

  let sanitized = rawContent;

  // Replace prompt injection attack patterns with neutral markers
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[FILTERED_UNTRUSTED_INSTRUCTION]");
  }

  // Remove potential raw XML/HTML tags that could clash with prompt boundaries
  sanitized = sanitized
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<\/?(?:system|instruction|prompt|context|evidence)[^>]*>/gi, "");

  // Normalize excessive whitespace and control characters
  sanitized = sanitized
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Enforce bounded length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength).trim() + "...";
  }

  return sanitized;
}
