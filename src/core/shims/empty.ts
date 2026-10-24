/** node:child_process / node:net 的惰性 shim（防御性：插件自身不用，防依赖引入）。 */
export default new Proxy(function noop() {}, {
  get() {
    return (..._a: any[]) => undefined;
  },
  apply() {
    return undefined;
  },
});
