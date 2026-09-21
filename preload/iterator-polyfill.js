/**
 * Iterator Helpers availability shim for Safari < 18.4 (iOS 17 and earlier).
 *
 * Why this is needed: dsh's client bundles feature-detect the helpers with
 * code like
 *
 *   typeof Iterator.prototype.join !== 'function' && (Iterator.prototype.join = ...)
 *
 * which is correct on engines that ship Iterator Helpers, but throws
 * `Can't find variable: Iterator` where the global does not exist at all —
 * the detection runs before any check can succeed. Safari gained the global in
 * 18.4, so iOS 17 devices cannot load those plugins without this file.
 *
 * Strategy: patch the shared %IteratorPrototype% so the helpers become
 * available on every built-in iterator (array iterators, map iterators, string
 * iterators, generator objects), then publish a minimal `Iterator` object whose
 * prototype IS that shared prototype, so `Iterator.prototype.x = ...` writes
 * land where they are actually useful.
 *
 * Only helpers absent from the engine are installed, so a future Safari that
 * ships the real thing keeps its native implementation.
 *
 * Loaded as a classic script before the module entry so it runs first.
 */
(function () {
  'use strict';

  // %IteratorPrototype% is the shared prototype of all built-in iterators.
  var iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

  /** Define an accessor or method only when the engine lacks it. */
  function define(target, name, value, writable) {
    if (name in target) return;
    Object.defineProperty(target, name, {
      value: value,
      writable: writable !== false,
      enumerable: false,
      configurable: true,
    });
  }

  define(iteratorPrototype, 'map', function map(mapper) {
    var source = this;
    return iteratorFrom(function () {
      var step = source.next();
      if (step.done) return step;
      return { value: mapper(step.value), done: false };
    });
  });

  define(iteratorPrototype, 'filter', function filter(predicate) {
    var source = this;
    return iteratorFrom(function () {
      for (;;) {
        var step = source.next();
        if (step.done) return step;
        if (predicate(step.value)) return step;
      }
    });
  });

  define(iteratorPrototype, 'take', function take(limit) {
    var source = this;
    var remaining = Math.max(0, Number(limit) || 0);
    return iteratorFrom(function () {
      if (remaining <= 0) return { value: undefined, done: true };
      remaining -= 1;
      return source.next();
    });
  });

  define(iteratorPrototype, 'drop', function drop(limit) {
    var source = this;
    var remaining = Math.max(0, Number(limit) || 0);
    var dropped = false;
    return iteratorFrom(function () {
      if (!dropped) {
        while (remaining > 0) {
          remaining -= 1;
          if (source.next().done) { dropped = true; return { value: undefined, done: true }; }
        }
        dropped = true;
      }
      return source.next();
    });
  });

  define(iteratorPrototype, 'flatMap', function flatMap(mapper) {
    var source = this;
    var inner = null;
    return iteratorFrom(function () {
      for (;;) {
        if (inner === null) {
          var step = source.next();
          if (step.done) return step;
          inner = toIterator(mapper(step.value));
        }
        var next = inner.next();
        if (next.done) { inner = null; continue; }
        return next;
      }
    });
  });

  define(iteratorPrototype, 'toArray', function toArray() {
    return Array.from(this);
  });

  define(iteratorPrototype, 'forEach', function forEach(callback) {
    for (;;) {
      var step = this.next();
      if (step.done) return undefined;
      callback(step.value);
    }
  });

  define(iteratorPrototype, 'reduce', function reduce(reducer, initial) {
    var accumulated = initial;
    var hasInitial = arguments.length > 1;
    for (;;) {
      var step = this.next();
      if (step.done) {
        if (!hasInitial) throw new TypeError('Reduce of empty iterator with no initial value');
        return accumulated;
      }
      if (!hasInitial) { accumulated = step.value; hasInitial = true; continue; }
      accumulated = reducer(accumulated, step.value);
    }
  });

  define(iteratorPrototype, 'some', function some(predicate) {
    for (;;) {
      var step = this.next();
      if (step.done) return false;
      if (predicate(step.value)) return true;
    }
  });

  define(iteratorPrototype, 'every', function every(predicate) {
    for (;;) {
      var step = this.next();
      if (step.done) return true;
      if (!predicate(step.value)) return false;
    }
  });

  define(iteratorPrototype, 'find', function find(predicate) {
    for (;;) {
      var step = this.next();
      if (step.done) return undefined;
      if (predicate(step.value)) return step.value;
    }
  });

  define(iteratorPrototype, 'join', function join(separator) {
    return Array.from(this).join(separator);
  });

  // Make every built-in iterator recognise itself as an iterator.
  // (target first: define(prototype, name, value))
  if (!(Symbol.iterator in iteratorPrototype)) {
    Object.defineProperty(iteratorPrototype, Symbol.iterator, {
      value: function () { return this },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  /** Wrap a next() thunk into an iterator inheriting the shared prototype. */
  function iteratorFrom(nextThunk) {
    var iterator = { next: nextThunk };
    Object.setPrototypeOf(iterator, iteratorPrototype);
    return iterator;
  }

  /** Coerce anything iterable into an iterator. */
  function toIterator(value) {
    if (value !== null && value !== undefined && typeof value.next === 'function') return value;
    var method = value[Symbol.iterator];
    return method.call(value);
  }

  // Publish the global so feature detection like `Iterator.prototype.join`
  // resolves instead of throwing a ReferenceError.
  if (typeof globalThis.Iterator === 'undefined') {
    var Iterator = function Iterator() {
      throw new TypeError('Abstract class Iterator not directly constructable');
    };
    Iterator.prototype = iteratorPrototype;
    define(Iterator, 'from', function from(value) {
      var iterator = toIterator(value);
      return Object.setPrototypeOf(
        { next: function next() { return iterator.next() } },
        iteratorPrototype,
      );
    });
    Object.defineProperty(globalThis, 'Iterator', {
      value: Iterator, writable: true, enumerable: false, configurable: true,
    });
  } else if (typeof globalThis.Iterator.prototype !== 'object') {
    // Some engines expose the global without the shared prototype link.
    globalThis.Iterator.prototype = iteratorPrototype;
  }
})();
