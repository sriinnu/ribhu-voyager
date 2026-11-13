import { AsyncLocalStorage } from "node:async_hooks";

import type { Awaitable, Storage } from "@ribhu-voyager/engine";

type TxCapable = Storage & {
  begin(): void;
  commit(): void;
  rollback(): void;
};

/**
 * SQLite has one synchronous connection. This facade serializes every public
 * operation through an async mutex, and holds that mutex for the whole
 * transaction callback so no other write can be swept into an open tx.
 */
export function serializedStorage(inner: TxCapable): Storage {
  const inTx = new AsyncLocalStorage<true>();
  let tail: Promise<unknown> = Promise.resolve();

  const lock = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "tx") {
        return <T>(fn: () => Awaitable<T>): Promise<T> => {
          if (inTx.getStore()) return Promise.resolve(fn());
          return lock(async () => {
            target.begin();
            try {
              const result = await inTx.run(true, fn);
              target.commit();
              return result;
            } catch (error) {
              target.rollback();
              throw error;
            }
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (inTx.getStore()) {
          return Promise.resolve(value.apply(target, args));
        }
        return lock(() => value.apply(target, args));
      };
    },
  }) as Storage;
}
