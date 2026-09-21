/**
 * Drop-in replacement for koffi's ESM entry (src/koffi/index.js) for the iOS
 * build of DeepSeek Harness.
 *
 * Why this exists: the real entry loads a native N-API module during module
 * evaluation and throws when neither the static nor the dynamic candidate is
 * present. Koffi publishes no iOS prebuild and `process.platform` is 'ios'
 * here, so importing koffi aborts boot — and two packages on the startup path
 * import it statically (`@deepseek-ai/dsh-subprocess-local`'s runner chunk, and
 * `@deepseek-ai/dsh-win32-process`).
 *
 * Why returning placeholders is enough: only ONE koffi call happens at module
 * scope on this path — `koffi.pointer("void")` in subprocess-local's
 * runner-launch chunk. Every other call (`struct`, `load`, `alloc`, `encode`,
 * `decode`, `errno`) sits inside a function that is reached only through a
 * Windows or Linux branch, or through the `subprocess` config row, which the
 * iOS overlay disables.
 *
 * So the contract this stub must honour is narrow: module evaluation must not
 * throw, and a returned type token must be a usable value. Each factory below
 * returns a chainable placeholder that tolerates further property access and
 * calls, so an accidental use degrades to a no-op instead of a crash. Nothing
 * here is evaluated at import time.
 *
 * @module koffi (iOS stub)
 */

/** A value that tolerates arbitrary property access and invocation. */
function placeholder(label) {
  const target = function placeholderTarget() { return another(label) };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'then') return undefined; // never look thenable
      if (prop === 'size' || prop === 'alignment' || prop === 'length') return 0;
      if (prop === 'name') return label;
      if (prop === Symbol.toStringTag) return `koffi-stub:${label}`;
      return another(`${label}.${String(prop)}`);
    },
    apply() { return another(label) },
    construct() { return another(label) },
  });
}

function another(label) { return placeholder(label) }

/** Factory-shaped export: returns a placeholder type token. */
function factory(name) {
  return function koffiStubFactory() { return placeholder(name) };
}

export const LibraryHandle = factory('LibraryHandle');
export const TypeObject = factory('TypeObject');
export const Union = factory('Union');
export const address = factory('address');
export const alias = factory('alias');
export const alignof = () => 0;
export const alloc = factory('alloc');
export const array = factory('array');
export const as = factory('as');
export const call = factory('call');
export const config = { sync: false, resident: false };
export const decode = factory('decode');
export const disposable = factory('disposable');
export const encode = () => undefined;
export const enumeration = factory('enumeration');
export const errno = () => 0;
export const extension = factory('extension');
export const free = () => undefined;
export const inout = factory('inout');
export const introspect = factory('introspect');
export const load = factory('load');
export const node = factory('node');
export const offsetof = () => 0;
export const opaque = factory('opaque');
export const os = { endianness: 'little', platform: 'ios', arch: 'arm64' };
export const out = factory('out');
export const pack = factory('pack');
export const pointer = factory('pointer');
export const proto = factory('proto');
export const register = factory('register');
export const reset = () => undefined;
export const resolve = factory('resolve');
export const sizeof = () => 0;
export const stats = factory('stats');
export const struct = factory('struct');
export const type = factory('type');
export const types = factory('types');
export const union = factory('union');
export const unregister = () => undefined;
export const version = '3.3.1-ios-stub';
export const view = factory('view');

// `in` is a reserved word, so it is bound and re-exported the way the upstream
// entry does it.
const mod_in = factory('in');
export { mod_in as in };

export default {
  LibraryHandle, TypeObject, Union, address, alias, alignof, alloc, array, as,
  call, config, decode, disposable, encode, enumeration, errno, extension, free,
  in: mod_in, inout, introspect, load, node, offsetof, opaque, os, out, pack,
  pointer, proto, register, reset, resolve, sizeof, stats, struct, type, types,
  union, unregister, version, view,
};
