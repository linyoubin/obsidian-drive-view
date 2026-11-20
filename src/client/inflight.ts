/**
 * inflight —— 按 key 合并「进行中」异步请求的纯逻辑（0.2.5）。
 *
 * 真机问题：「重复点击同一个文件很多次，一样会有很多后台下载任务」。
 * 做法：**在发起网络请求之前**按 key（下载用 fid）查表；已有进行中的 Promise 就复用，
 * 不再发起第二次请求；请求结束（成功或失败）后立刻清理，允许缓存被逐出后重新发起。
 *
 * 取消语义（0.2.4 A5 的延续）：调用方取消**只放弃自己的等待**，
 * 不会取消共享的那次下载——其它调用方仍会拿到结果并照常写缓存。
 * 本模块不处理取消，只保证「同一个 key 全局只有一份在执行」。
 */

export type InflightFactory<T> = () => Promise<T>;

export class InflightRequests {
  private readonly map = new Map<string, Promise<unknown>>();

  /** 当前进行中的 key 数。 */
  get size(): number {
    return this.map.size;
  }

  /** 某个 key 是否正在执行。 */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** 进行中的全部 key（观测/单测用）。 */
  keys(): string[] {
    return Array.from(this.map.keys());
  }

  /**
   * 同一个 key 只执行一次 `task()`：
   *   - 已有进行中的 Promise → 直接返回它（不调用 task）；
   *   - 否则调用 task 并把 Promise 存表，完成/失败后从表里删除（不缓存结果）。
   */
  run<T>(key: string, task: InflightFactory<T>): Promise<T> {
    const existing = this.map.get(key);
    if (existing) return existing as Promise<T>;

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(task());
    } catch (error) {
      // 同步抛错：不留下脏表项
      return Promise.reject(error);
    }
    const tracked = pending.finally(() => {
      if (this.map.get(key) === tracked) this.map.delete(key);
    });
    this.map.set(key, tracked);
    return tracked;
  }

  /** 清空（插件卸载用；不会取消已在执行的任务）。 */
  clear(): void {
    this.map.clear();
  }
}
