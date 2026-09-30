/**
 * Secret redaction for the law.go.kr OC key. The key is an identifier bound to the operator's
 * registered IP/domain; it must never reach logs, error messages, reports or fixtures.
 */

const OC_PARAM = /(\bOC=)[^&\s"'<>]*/gi;

/** Redacts every `OC=<value>` query parameter, plus any explicitly known secret values. */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text.replace(OC_PARAM, "$1[REDACTED]");
  for (const secret of knownSecrets) {
    if (secret.length < 3) continue;
    out = out.split(secret).join("[REDACTED]");
    out = out.split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  return out;
}
