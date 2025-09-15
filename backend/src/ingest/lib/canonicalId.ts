// Verbatim canonical ID logic extracted from prnewswire on 2025-09-12; shared across adapters.

export type CanonicalInput = {
  guid?: string;
  url?: string;
  title?: string;
};

export function canonicalIdFromItem(input: CanonicalInput): string {
  // prnewswire sets id from the parsed item guid, which itself may have been
  // derived from the RSS <guid> or <link> during extraction. We preserve that.
  return String(input.guid ?? "");
}


