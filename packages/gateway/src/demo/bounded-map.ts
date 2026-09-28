/** 只用于可重新计算的缓存；执行锁、在飞任务、账本不可用此类淘汰。 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly capacity: number) { super(); }
  override set(key: K, value: V): this {
    this.delete(key);
    if (this.size >= this.capacity) this.delete(this.keys().next().value!);
    return super.set(key, value);
  }
}
