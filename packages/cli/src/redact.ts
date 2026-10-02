import type { Output } from './context';

/** Replaces secret values with `***` in text webscoop writes. */
export class Redactor {
  private readonly values: string[];

  constructor(values: Iterable<string>) {
    // Longest first, so a secret containing another is masked whole.
    this.values = [...new Set([...values].filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
  }

  /** A redactor for the secret variables among `vars`. */
  static of(vars: Readonly<Record<string, string>> | undefined, secrets: readonly string[] | undefined): Redactor {
    return new Redactor((secrets ?? []).flatMap((name) => (vars?.[name] !== undefined ? [vars[name]!] : [])));
  }

  get empty(): boolean {
    return this.values.length === 0;
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.values) out = out.split(value).join('***');
    return out;
  }

  /** `output` with every write redacted. */
  wrap(output: Output): Output {
    if (this.empty) return output;
    return { write: (data: string) => output.write(this.redact(data)) };
  }
}
