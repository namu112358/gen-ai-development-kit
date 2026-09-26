/** 依存なしの小さな検証ヘルパー。エラーは path 付きで errors に積む */
export class Checker {
  readonly errors: string[] = [];

  object(value: unknown, path: string): Record<string, unknown> | null {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    this.errors.push(`${path}: オブジェクトではありません`);
    return null;
  }

  string(value: unknown, path: string, { nonEmpty = false } = {}): string {
    if (typeof value !== 'string') {
      this.errors.push(`${path}: 文字列ではありません`);
      return '';
    }
    if (nonEmpty && value.trim() === '') this.errors.push(`${path}: 空です`);
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
      this.errors.push(`${path}: 真偽値ではありません`);
      return false;
    }
    return value;
  }

  integer(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.errors.push(`${path}: 整数ではありません`);
      return 0;
    }
    return value;
  }

  number(value: unknown, path: string, min = -Infinity, max = Infinity): number {
    if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
      this.errors.push(`${path}: ${min}〜${max} の数値ではありません`);
      return 0;
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
    this.errors.push(`${path}: ${options.join(' / ')} のいずれかではありません`);
    return options[0]!;
  }

  stringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) {
      this.errors.push(`${path}: 配列ではありません`);
      return [];
    }
    return value.map((item, i) => this.string(item, `${path}[${i}]`));
  }

  array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) {
      this.errors.push(`${path}: 配列ではありません`);
      return [];
    }
    return value;
  }
}
