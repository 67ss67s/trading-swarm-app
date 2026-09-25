/** 容量估算的十进制有理数。网格取整与风险比较不经过二进制浮点。 */
export class CapacityDecimal {
  private constructor(readonly n: bigint, readonly d: bigint) {}

  static from(value: string | number): CapacityDecimal {
    const text = String(value);
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
    if (!m || text.length > 128) throw new Error('容量数值不是有限十进制');
    const scale = (m[3]?.length ?? 0) - Number(m[4] ?? 0);
    if (Math.abs(scale) > 100) throw new Error('容量数值精度超限');
    const n = BigInt(`${m[1]}${m[2]}${m[3] ?? ''}`);
    return new CapacityDecimal(scale < 0 ? n * 10n ** BigInt(-scale) : n, scale > 0 ? 10n ** BigInt(scale) : 1n);
  }

  add(v: CapacityDecimal): CapacityDecimal { return new CapacityDecimal(this.n * v.d + v.n * this.d, this.d * v.d); }
  sub(v: CapacityDecimal): CapacityDecimal { return new CapacityDecimal(this.n * v.d - v.n * this.d, this.d * v.d); }
  mul(v: CapacityDecimal): CapacityDecimal { return new CapacityDecimal(this.n * v.n, this.d * v.d); }
  div(v: CapacityDecimal): CapacityDecimal {
    if (v.n <= 0n) throw new Error('容量除数必须为正');
    return new CapacityDecimal(this.n * v.d, this.d * v.n);
  }
  cmp(v: CapacityDecimal): number {
    const diff = this.n * v.d - v.n * this.d;
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  }
  max(v: CapacityDecimal): CapacityDecimal { return this.cmp(v) >= 0 ? this : v; }
  min(v: CapacityDecimal): CapacityDecimal { return this.cmp(v) <= 0 ? this : v; }
  ceilTo(step: CapacityDecimal): CapacityDecimal {
    const units = this.div(step);
    return new CapacityDecimal((units.n + units.d - 1n) / units.d, 1n).mul(step);
  }
  /** 非负金额向上保留 12 位小数(权益门槛可传 2 向上取分)。 */
  text(places = 12): string {
    if (this.n < 0n) throw new Error('容量金额必须非负');
    const scale = 10n ** BigInt(places);
    const scaled = (this.n * scale + this.d - 1n) / this.d;
    const digits = scaled.toString().padStart(places + 1, '0');
    return places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, '');
  }
}

export const capacityDecimal = CapacityDecimal.from;
