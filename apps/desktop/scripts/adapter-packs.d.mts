export function buildPacks(options: {
  out: string;
  only?: string[];
  nsa?: string;
  catalog?: boolean;
  signing?: { pem: string; publisher: string };
  unsigned?: boolean;
  overrides?: Record<string, { version?: string; nsa?: string; patch?: (code: string) => string }>;
}): Promise<{ indexFile: string }>;
